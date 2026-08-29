import type { WorldEvent, WorldEventsRollup } from "@farlands/contracts";
import { DEFAULT_MAX_SESSION_SECONDS, SessionLedger } from "./sessions.ts";
import type { RollupStore } from "./store.ts";
import { WindowAccumulator } from "./window.ts";

/**
 * Rolling window aggregation, one open window per server.
 *
 * Windows are aligned to absolute time (floor of the event timestamp over the
 * window length) rather than to the first event seen. Alignment matters because
 * the evaluation harness compares a window before a deployment with a window
 * after it, and two windows are only comparable if their boundaries were not
 * chosen by whichever batch happened to arrive first.
 *
 * Exactly one window per server is open at a time. An event that belongs to a
 * window already closed is dropped and counted, because reopening it would
 * require having kept the events that built it, which is the thing this module
 * does not do. In practice the emitter batches in order and the drop count
 * stays at zero; a non-zero count is a signal that batches are arriving out of
 * order and is worth surfacing rather than hiding.
 */

export const DEFAULT_WINDOW_SECONDS = 300;

/**
 * A store that never answers is the same problem as a store that rejects, but
 * it fails in the worse direction: without a deadline the write chain stops
 * forever and every later window queues behind it.
 */
export const DEFAULT_STORE_TIMEOUT_MS = 5_000;

export interface AggregatorOptions {
  store: RollupStore;
  /** Window length. Aligned to absolute time, so this also fixes the boundaries. */
  windowSeconds?: number;
  /** A join older than this is presumed lost. Bounds the open-session ledger. */
  maxSessionSeconds?: number;
  /** Deadline for one store write before the window is abandoned. */
  storeTimeoutMs?: number;
  /**
   * Called when the store refuses a window. The default is deliberately quiet;
   * a caller that wants a metric or a log line supplies one.
   */
  onStoreError?: (error: unknown, rollup: WorldEventsRollup) => void;
}

export interface IngestOutcome {
  /** Events folded into a window. */
  accepted: number;
  /** Events whose window had already closed. */
  late: number;
  /** Windows closed by this call and handed to the store. */
  closed: number;
}

interface ServerState {
  open: WindowAccumulator | null;
  sessions: SessionLedger;
  /** Newest window start already closed, so late events are recognisable. */
  lastClosedStartMs: number;
}

export class TelemetryAggregator {
  private readonly store: RollupStore;
  private readonly windowMs: number;
  private readonly maxSessionMs: number;
  private readonly storeTimeoutMs: number;
  private readonly onStoreError: (error: unknown, rollup: WorldEventsRollup) => void;
  private readonly servers = new Map<string, ServerState>();

  /**
   * Writes are chained rather than awaited by callers. The request path must
   * never wait on persistence: a slow store would turn into a slow ingest, and
   * a slow ingest turns into an emitter backing up inside the game server.
   */
  private writes: Promise<void> = Promise.resolve();
  private droppedWindows = 0;
  private lateEvents = 0;

  constructor(options: AggregatorOptions) {
    this.store = options.store;
    this.windowMs = (options.windowSeconds ?? DEFAULT_WINDOW_SECONDS) * 1000;
    this.maxSessionMs = (options.maxSessionSeconds ?? DEFAULT_MAX_SESSION_SECONDS) * 1000;
    this.storeTimeoutMs = options.storeTimeoutMs ?? DEFAULT_STORE_TIMEOUT_MS;
    this.onStoreError = options.onStoreError ?? (() => {});
  }

  /**
   * Fold a validated batch into the open windows.
   *
   * Synchronous on purpose. Everything this method does is arithmetic over
   * counters, so there is nothing to await, and having no await means there is
   * no path by which a store, a network or a database can make ingest slow.
   */
  ingest(serverId: string, events: readonly WorldEvent[]): IngestOutcome {
    const state = this.stateFor(serverId);
    let accepted = 0;
    let late = 0;
    let closed = 0;

    for (const event of events) {
      const startMs = Math.floor(Date.parse(event.ts) / this.windowMs) * this.windowMs;

      if (state.open === null) {
        // A window that was already closed cannot be reopened without the
        // events that built it, and those are gone by design.
        if (startMs <= state.lastClosedStartMs) {
          late += 1;
          this.lateEvents += 1;
          continue;
        }
        state.open = new WindowAccumulator(startMs, startMs + this.windowMs);
      } else if (startMs > state.open.startMs) {
        this.closeWindow(serverId, state);
        closed += 1;
        state.open = new WindowAccumulator(startMs, startMs + this.windowMs);
      } else if (startMs < state.open.startMs) {
        late += 1;
        this.lateEvents += 1;
        continue;
      }

      state.open.add(event, state.sessions);
      accepted += 1;
    }

    return { accepted, late, closed };
  }

  /**
   * Close every open window and wait for persistence to settle.
   *
   * Two callers: the scheduled flush that closes a window whose wall clock has
   * passed even though no further events arrived, and tests, which need a point
   * at which the store is known to have been written.
   */
  async flush(serverId?: string): Promise<void> {
    const ids = serverId === undefined ? [...this.servers.keys()] : [serverId];
    for (const id of ids) {
      const state = this.servers.get(id);
      if (state?.open) this.closeWindow(id, state);
    }
    await this.settled();
  }

  /** Resolves once every window handed to the store has been written or dropped. */
  async settled(): Promise<void> {
    await this.writes;
  }

  /** Windows the store refused. A rising count means telemetry is being lost, not the game. */
  get storeFailures(): number {
    return this.droppedWindows;
  }

  /** Events that arrived after their window closed. */
  get lateDropped(): number {
    return this.lateEvents;
  }

  /**
   * Everything held in memory right now, for tests that inspect rather than
   * trust. It reports sizes, not contents, because there are no contents to
   * report: an open window is counters and a name set, and the ledger is one
   * timestamp per online player.
   */
  liveState(): Record<string, { hasOpenWindow: boolean; openSessions: number }> {
    const out: Record<string, { hasOpenWindow: boolean; openSessions: number }> = {};
    for (const [id, state] of this.servers) {
      out[id] = { hasOpenWindow: state.open !== null, openSessions: state.sessions.openCount };
    }
    return out;
  }

  private stateFor(serverId: string): ServerState {
    const existing = this.servers.get(serverId);
    if (existing) return existing;
    const created: ServerState = {
      open: null,
      sessions: new SessionLedger(this.maxSessionMs),
      lastClosedStartMs: Number.NEGATIVE_INFINITY,
    };
    this.servers.set(serverId, created);
    return created;
  }

  private closeWindow(serverId: string, state: ServerState): void {
    const open = state.open;
    if (open === null) return;

    const rollup: WorldEventsRollup = {
      server_id: serverId,
      window_start: new Date(open.startMs).toISOString(),
      window_end: new Date(open.endMs).toISOString(),
      metrics: open.toMetrics(),
    };

    // Dropping the accumulator here is what makes the window the only place
    // individual events are ever reflected, and even there only as counters.
    state.open = null;
    state.lastClosedStartMs = open.startMs;
    state.sessions.prune(open.endMs);

    this.enqueue(rollup);
  }

  /**
   * Hand one rollup to the store without letting it reach the caller.
   *
   * A store that rejects, throws before returning a promise, or never resolves
   * must not fail an ingest request. The chain keeps writes ordered, the catch
   * makes every failure terminal for that one window, and the counter means a
   * broken store is visible rather than silent.
   */
  private enqueue(rollup: WorldEventsRollup): void {
    this.writes = this.writes.then(async () => {
      try {
        await this.putWithDeadline(rollup);
      } catch (error) {
        this.droppedWindows += 1;
        this.onStoreError(error, rollup);
      }
    });
  }

  private async putWithDeadline(rollup: WorldEventsRollup): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        // Called inside the race rather than before it so a store that throws
        // synchronously is caught here too, not on the caller's stack.
        (async () => this.store.put(rollup))(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("rollup store did not respond in time")),
            this.storeTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
