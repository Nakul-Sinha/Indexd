import type { DeploymentState, DeploymentStateEvent } from "@farlands/contracts";
import { isAbortable, isTerminal, PROVISIONAL_STALL_BUDGET_MS } from "@farlands/contracts";
import type { ApiClient } from "./api.ts";
import type { OutputPort } from "./output/index.ts";
import { subscribe } from "./sse.ts";

/**
 * Following a deployment: the stream, the fallback, and the stall budget.
 *
 * One object per state transition is the whole point of the NDJSON mode, and it
 * is what lets a caller that is not a person notice that nothing has happened
 * for a while. A deployment that fails is fine; a deployment that hangs is the
 * case nobody handles, because there is no error to react to.
 *
 * The budgets come from PROVISIONAL_STALL_BUDGET_MS in the contracts package,
 * and the name is not decoration. They are placeholders until the M1 measurement
 * lands, so every surface that shows one says provisional out loud: the CLI must
 * not present them as measured, because a number that looks measured gets quoted
 * back as though it were. When M1 reports, the table changes in one place and
 * this file does not change at all.
 */

/** How often the poll fallback asks, when the stream is quiet. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

export type StallPolicy = "report" | "abort";

export interface RawTransition {
  deployment_id: string;
  state: DeploymentState;
  detail: string | null;
  ts: string;
}

export interface TransitionFeed {
  /** The next transition, or null when the wait elapsed first. */
  next(timeoutMs: number): Promise<RawTransition | null>;
  close(): void;
}

/**
 * A one-consumer queue with a deadline.
 *
 * The watch loop has to wait on whichever of three things happens first: a
 * pushed transition, the poll interval, or the stall budget. Expressing that as
 * a single awaited call keeps the loop readable and keeps the timer bookkeeping
 * in one place.
 */
class Channel<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | null = null;

  push(item: T): void {
    this.items.push(item);
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async next(timeoutMs: number): Promise<T | null> {
    const queued = this.items.shift();
    if (queued !== undefined) return queued;
    if (timeoutMs <= 0) return null;

    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      this.waiter = resolve;
      if (Number.isFinite(timeoutMs)) timer = setTimeout(resolve, timeoutMs);
    });
    if (timer) clearTimeout(timer);
    this.waiter = null;
    return this.items.shift() ?? null;
  }
}

/**
 * Open the transition feed before the deployment is created.
 *
 * Order matters. Subscribing after the POST returns races the first few
 * transitions, and a stream that starts at staging is indistinguishable from one
 * that missed building. The poll fallback would recover the current state but
 * not the transitions that were skipped, and skipped transitions are exactly
 * what the NDJSON contract promises not to do.
 */
export function openTransitionFeed(options: {
  api: ApiClient;
  serverId: string;
  out: OutputPort;
}): TransitionFeed {
  const channel = new Channel<RawTransition>();
  const controller = new AbortController();

  const pump = async () => {
    for await (const event of subscribe(options.api, {
      serverId: options.serverId,
      signal: controller.signal,
      onReconnect: (lastEventId, attempt) => {
        options.out.warn(
          `event stream dropped, resuming from ${lastEventId ?? "the beginning"} (attempt ${attempt})`,
        );
      },
    })) {
      if (event.type !== "deployment_state") continue;
      channel.push({
        deployment_id: event.data.deployment_id,
        state: event.data.state,
        detail: event.data.detail,
        ts: event.ts,
      });
    }
  };

  // The stream is best effort. Losing it degrades the watch to polling, which is
  // slower but not wrong, so a stream fault is a warning and not a failure.
  pump().catch((error: unknown) => {
    options.out.warn(
      `event stream unavailable, falling back to polling: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  return {
    next: (timeoutMs) => channel.next(timeoutMs),
    close: () => controller.abort(),
  };
}

export interface WatchOptions {
  api: ApiClient;
  out: OutputPort;
  feed: TransitionFeed;
  serverId: string;
  deploymentId: string;
  initialState: DeploymentState;
  initialDetail?: string | null;
  rollbackCommand: string;
  onStall: StallPolicy;
  /** Overrides the provisional table. Null means this state has no budget. */
  budgetFor?: (state: DeploymentState) => number | null;
  pollIntervalMs?: number;
  now?: () => number;
}

export interface WatchResult {
  finalState: DeploymentState;
  transitions: DeploymentStateEvent[];
  stalled: boolean;
  abortRequested: boolean;
  elapsedMs: number;
}

export async function watchDeployment(options: WatchOptions): Promise<WatchResult> {
  const now = options.now ?? (() => Date.now());
  const budgetFor = options.budgetFor ?? ((state: DeploymentState) => stallBudget(state));
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const startedAt = now();
  const transitions: DeploymentStateEvent[] = [];
  let current = options.initialState;
  let stateEnteredAt = startedAt;
  let lastPollAt = startedAt;
  let stalled = false;
  let abortRequested = false;

  const emit = (state: DeploymentState, detail: string | null, ts: string) => {
    const event: DeploymentStateEvent = {
      event: "deployment_state",
      deployment_id: options.deploymentId,
      server_id: options.serverId,
      state,
      detail,
      ts,
    };
    transitions.push(event);
    options.out.transition(event);
  };

  try {
    emit(current, options.initialDetail ?? null, new Date(startedAt).toISOString());

    while (!isTerminal(current)) {
      const budget = budgetFor(current);
      const stallAt = budget === null ? Number.POSITIVE_INFINITY : stateEnteredAt + budget;
      const pollAt = lastPollAt + pollIntervalMs;
      const waitMs = Math.min(stallAt, pollAt) - now();

      const transition = await options.feed.next(waitMs);
      if (transition && transition.deployment_id === options.deploymentId) {
        if (transition.state === current) continue;
        current = transition.state;
        stateEnteredAt = now();
        emit(current, transition.detail, transition.ts);
        continue;
      }
      if (transition) continue;

      if (now() >= pollAt) {
        lastPollAt = now();
        const polled = await pollState(options, current);
        if (polled && polled.state !== current) {
          current = polled.state;
          stateEnteredAt = now();
          emit(current, polled.detail, new Date(stateEnteredAt).toISOString());
          continue;
        }
      }

      if (now() < stallAt) continue;

      stalled = true;
      const elapsedInState = now() - stateEnteredAt;
      options.out.stalled({
        deployment_id: options.deploymentId,
        server_id: options.serverId,
        state: current,
        budget_ms: budget ?? 0,
        elapsed_ms: elapsedInState,
        budget_source: "provisional",
        policy: options.onStall,
        ts: new Date(now()).toISOString(),
      });

      if (options.onStall !== "abort") break;

      // Abort is safe before cutover and a no-op after, and the classification
      // lives in the contract rather than in a second list here.
      if (!isAbortable(current)) {
        options.out.warn(
          `${current} is past the point where abort helps; leaving the deployment alone`,
        );
        break;
      }

      const aborted = await options.api.abortDeployment(options.deploymentId);
      abortRequested = true;
      if (aborted.no_op) {
        options.out.warn("abort was a no-op: the deployment had already passed cutover");
        break;
      }
      current = aborted.state;
      stateEnteredAt = now();
      emit(
        current,
        "aborted after exceeding a provisional stall budget",
        new Date(stateEnteredAt).toISOString(),
      );
    }
  } finally {
    options.feed.close();
  }

  const elapsedMs = now() - startedAt;
  options.out.deploymentClosed({
    deployment_id: options.deploymentId,
    server_id: options.serverId,
    final_state: current,
    elapsed_ms: elapsedMs,
    rollback_command: options.rollbackCommand,
    ts: new Date(now()).toISOString(),
  });

  return { finalState: current, transitions, stalled, abortRequested, elapsedMs };
}

/** The provisional budget for a state. Never presented as a measured figure. */
export function stallBudget(state: DeploymentState): number | null {
  return PROVISIONAL_STALL_BUDGET_MS[state];
}

async function pollState(
  options: WatchOptions,
  current: DeploymentState,
): Promise<{ state: DeploymentState; detail: string | null } | null> {
  try {
    const { deployment } = await options.api.getDeployment(options.deploymentId);
    return { state: deployment.state, detail: deployment.error };
  } catch (error) {
    // A failed poll is not a stall. Warn and let the budget decide.
    options.out.warn(
      `could not poll ${options.deploymentId} while in ${current}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
