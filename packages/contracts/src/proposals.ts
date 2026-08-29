import { type Static, Type } from "@sinclair/typebox";
import { ProposalId, ServerId, Timestamp } from "./common.ts";
import { RollupMetrics } from "./telemetry.ts";

/**
 * Director proposals, and the evaluation records that grade them.
 *
 * A proposal is a queued row a human must approve. The Director has no code path
 * to a deployment, which is asserted by a test rather than assumed.
 */

export const ProposalStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("approved"),
  Type.Literal("rejected"),
]);
export type ProposalStatus = Static<typeof ProposalStatus>;

export const Proposal = Type.Object({
  proposal_id: ProposalId,
  server_id: ServerId,
  /** The rule document the Director is proposing, validated before it is stored. */
  suggested_rules: Type.Unknown(),
  /** Why, in plain language, for a human reading a phone notification. */
  rationale: Type.String({ minLength: 1, maxLength: 2000 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  /** What the Director observed, so the reasoning can be checked against data. */
  observed: Type.Union([RollupMetrics, Type.Null()]),
  status: ProposalStatus,
  reviewed_by: Type.Union([Type.String(), Type.Null()]),
  reviewed_at: Type.Union([Timestamp, Type.Null()]),
  /**
   * The most useful signal in the system: ground truth about what an owner
   * actually wants, captured at the moment they were paying attention. Fed back
   * into the Director context for that server.
   */
  rejection_reason: Type.Union([Type.String({ maxLength: 1000 }), Type.Null()]),
  created_at: Timestamp,
});
export type Proposal = Static<typeof Proposal>;

/**
 * An evaluation record.
 *
 * pre_post is an interrupted time series around one deployment on one server. It
 * is not a controlled trial: order effects, time of day, novelty and player
 * memory are all uncontrolled, and the sample is a friend group. parallel means
 * two servers with a split population and costs double the infrastructure.
 *
 * The output is delta and n, never a winner.
 */
export const ExperimentDesign = Type.Union([Type.Literal("pre_post"), Type.Literal("parallel")]);
export type ExperimentDesign = Static<typeof ExperimentDesign>;

/** Which arm produced this record. The baseline arm is what makes the comparison exist. */
export const ExperimentArm = Type.Union([
  Type.Literal("director"),
  Type.Literal("human"),
  Type.Literal("random_baseline"),
]);
export type ExperimentArm = Static<typeof ExperimentArm>;

export const Experiment = Type.Object({
  experiment_id: Type.String(),
  design: ExperimentDesign,
  arm: ExperimentArm,
  server_id: ServerId,
  deployment_id: Type.String(),
  rule_version: Type.Integer({ minimum: 1 }),
  window_before: Type.Object({ start: Timestamp, end: Timestamp }),
  window_after: Type.Object({ start: Timestamp, end: Timestamp }),
  metrics_before: RollupMetrics,
  metrics_after: RollupMetrics,
  /** Per-metric change. Reported as-is, with no significance claim attached. */
  delta: Type.Record(Type.String(), Type.Number()),
  n_players: Type.Integer({ minimum: 0 }),
  n_sessions: Type.Integer({ minimum: 0 }),
  /** Confounds worth naming for this particular run. */
  notes: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
  created_at: Timestamp,
});
export type Experiment = Static<typeof Experiment>;

/**
 * Every experiment report carries this text. It is a constant rather than prose
 * a caller writes, so no surface can quietly drop it.
 */
export const EXPERIMENT_CONFOUND_NOTICE =
  "Interrupted time series on a single server. Uncontrolled for order effects, time of day, " +
  "novelty, and player memory across the change. Report delta and n; this design cannot " +
  "support a significance claim.";
