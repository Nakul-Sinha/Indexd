import type {
  Deployment,
  Experiment,
  ExperimentArm,
  ExperimentDesign,
  WorldEventsRollup,
} from "@farlands/contracts";
import { type ConfoundTag, DESIGN_CONFOUNDS, renderNotes } from "./confounds.ts";
import { countSample, metricDelta } from "./metrics.ts";
import type { ExperimentStore } from "./store.ts";
import { DEFAULT_SPAN_MS, selectWindows } from "./windows.ts";

/**
 * The harness: one completed deployment in, one experiment row out.
 *
 * What this module is for, and what it is careful not to become:
 *
 * A rule change on a server with telemetry has a before window and an after
 * window, and the difference between them is a measurement. That measurement is
 * worth having. It is not a controlled trial, and the gap between those two
 * things is where this module spends most of its code.
 *
 * `pre_post` is an interrupted time series around one deployment on one server.
 * The arms run in sequence, so anything that changed with time changed with the
 * arm: the hour of the evening, how long the group had been playing, and how
 * new the rules felt. Players carry memory across the change, and no snapshot
 * restore resets that; the second arm is played by people who already know what
 * the first arm did. The sample is a friend group. Those limits are not caveats
 * appended to a result, they are the reason the row carries `delta`, `n_players`
 * and `n_sessions` and nothing that resembles a verdict.
 *
 * `parallel`, two servers with a split population, is the design that removes
 * order effects, and it costs double the infrastructure. It is supported here
 * and recorded only when a second server actually ran the counterpart, which is
 * why `design` is derived from evidence rather than taken as an argument.
 *
 * What is deliberately absent: any way to run two arms from one snapshot on one
 * live server. Returning to the snapshot for the second arm is a restore, and a
 * restore discards everything played during the first arm. That is a real cost
 * paid by real people, and nobody accepts it twice. Naming the same server as
 * its own parallel peer raises rather than recording a design.
 */

export interface ParallelRun {
  /** The other server in the split. Must not be the server under evaluation. */
  server_id: string;
  /** The counterpart deployment that actually ran there. */
  deployment_id: string;
}

/**
 * Raised when a caller names the server under evaluation as its own parallel
 * peer. The only way to get a second arm out of one server is a snapshot
 * restore between them, which throws away the play that the first arm produced.
 */
export class SameServerParallelError extends Error {
  constructor(readonly serverId: string) {
    super(
      `server ${serverId} cannot be its own parallel peer: a second arm on one server requires a snapshot restore, which discards the play the first arm produced`,
    );
    this.name = "SameServerParallelError";
  }
}

/**
 * The design that actually ran.
 *
 * Derived, never declared. A caller who intended a parallel trial and deployed
 * to one server records `pre_post`, because that is what happened, and the row
 * is the only place anyone will look a month later.
 */
export function deriveDesign(deployment: Deployment, parallel?: ParallelRun): ExperimentDesign {
  if (parallel === undefined) return "pre_post";
  if (parallel.server_id === deployment.server_id) {
    throw new SameServerParallelError(deployment.server_id);
  }
  if (parallel.deployment_id === deployment.deployment_id) {
    throw new SameServerParallelError(deployment.server_id);
  }
  return "parallel";
}

/**
 * A deployment worth evaluating: one that finished, on purpose, in the state the
 * machine calls done. Aborted and failed deployments changed nothing players
 * saw, so there is no after window to compare against.
 */
export function isEvaluable(deployment: Deployment): boolean {
  return deployment.state === "idle" && deployment.finished_at !== null;
}

export type SkipReason =
  /** The deployment aborted, failed, or has not reached a terminal state. */
  | "deployment_not_complete"
  /** The server records no telemetry before the cutover. Uninstrumented, or new. */
  | "no_telemetry_before"
  /** The server records no telemetry after the cutover. Uninstrumented, or nobody played. */
  | "no_telemetry_after";

export type RecordOutcome =
  | { recorded: true; experiment: Experiment }
  | { recorded: false; reason: SkipReason };

export interface RecordInput {
  deployment: Deployment;
  /** Which arm produced the rule version this deployment carried. */
  arm: ExperimentArm;
  /** The server's rollups. Windows either side of the cutover are selected from these. */
  rollups: readonly WorldEventsRollup[];
  /** Evidence of a counterpart run on a second server, if there was one. */
  parallel?: ParallelRun;
  /** Confounds specific to this run, added to the ones the design always carries. */
  confounds?: readonly ConfoundTag[];
  /** How far either side of the cutover to reach. Same span both sides. */
  spanMs?: number;
}

export interface HarnessOptions {
  store: ExperimentStore;
  /** Injected so a row can be reproduced in a test rather than only observed. */
  newId?: () => string;
  now?: () => Date;
  spanMs?: number;
}

export class EvaluationHarness {
  private readonly store: ExperimentStore;
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly spanMs: number;

  constructor(options: HarnessOptions) {
    this.store = options.store;
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date());
    this.spanMs = options.spanMs ?? DEFAULT_SPAN_MS;
  }

  /**
   * Build and persist the row for one completed deployment.
   *
   * The arm is carried through as data. There is no branch on it anywhere in
   * this method or in the reporting that follows, which is what "the baseline
   * arm is measured identically" has to mean if it is to mean anything: not a
   * promise that the code treats the arms alike, but no code that could do
   * otherwise.
   */
  async record(input: RecordInput): Promise<RecordOutcome> {
    const { deployment } = input;
    if (!isEvaluable(deployment) || deployment.finished_at === null) {
      return { recorded: false, reason: "deployment_not_complete" };
    }

    const design = deriveDesign(deployment, input.parallel);

    // The deployment row carries no cutover timestamp of its own, so the
    // finish time stands in. It is later than the cutover by one drain, which
    // shifts the boundary by seconds against windows measured in minutes.
    const cutoverAt = deployment.finished_at;

    const selection = selectWindows(input.rollups, cutoverAt, {
      spanMs: input.spanMs ?? this.spanMs,
    });
    if (!selection.ok) return { recorded: false, reason: selection.reason };

    const { before, after, straddling } = selection;
    const sample = countSample(before, after);

    const tags = new Set<ConfoundTag>([
      ...DESIGN_CONFOUNDS[design],
      "counts_are_lower_bounds",
      ...(input.confounds ?? []),
    ]);
    if (straddling > 0) tags.add("straddling_window_dropped");
    if (before.windows > 1 || after.windows > 1) tags.add("unweighted_window_means");

    const experiment: Experiment = {
      experiment_id: this.newId(),
      design,
      arm: input.arm,
      server_id: deployment.server_id,
      deployment_id: deployment.deployment_id,
      rule_version: deployment.to_version,
      window_before: { start: before.start, end: before.end },
      window_after: { start: after.start, end: after.end },
      metrics_before: before.metrics,
      metrics_after: after.metrics,
      delta: metricDelta(before.metrics, after.metrics),
      n_players: sample.n_players,
      n_sessions: sample.n_sessions,
      notes: renderNotes([...tags]),
      created_at: this.now().toISOString(),
    };

    await this.store.put(experiment);
    return { recorded: true, experiment };
  }
}
