import { type Static, Type } from "@sinclair/typebox";
import { DeploymentId, ServerId, Timestamp } from "./common.ts";

/**
 * The deployment state machine.
 *
 * Engineer 2 owns this union: they author it, Engineer 3 hosts it here. This is
 * the Phase 0 draft they amend, not a finished decision taken without them.
 *
 * The names are the canonical ones from CONTEXT.md section 5 and they are used
 * verbatim by the CLI NDJSON stream, the MCP get_deployment response, the SSE
 * envelope and the web progress UI. Nobody invents friendlier names downstream.
 */
export const DeploymentState = Type.Union(
  [
    Type.Literal("queued"),
    Type.Literal("building"),
    Type.Literal("staging"),
    Type.Literal("presync"),
    Type.Literal("freezing"),
    Type.Literal("verifying"),
    Type.Literal("cutover"),
    Type.Literal("draining"),
    Type.Literal("idle"),
    Type.Literal("aborted"),
    Type.Literal("failed"),
  ],
  { description: "Canonical deployment state. Engineer 2 owns this union." },
);
export type DeploymentState = Static<typeof DeploymentState>;

/**
 * States before cutover has completed. This encodes the invariant: pod A remains
 * authoritative and recoverable throughout every state in this list, so an abort
 * here costs a deleted candidate and a return trip from the lobby, and nothing
 * else. Consumers use this rather than re-listing the states, so the invariant
 * has one definition.
 */
export const PRE_CUTOVER_STATES = [
  "queued",
  "building",
  "staging",
  "presync",
  "freezing",
  "verifying",
] as const satisfies readonly DeploymentState[];

export const TERMINAL_STATES = [
  "idle",
  "aborted",
  "failed",
] as const satisfies readonly DeploymentState[];

export function isPreCutover(state: DeploymentState): boolean {
  return (PRE_CUTOVER_STATES as readonly string[]).includes(state);
}

export function isTerminal(state: DeploymentState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** Abort is safe at any state before cutover and is a no-op afterwards. */
export function isAbortable(state: DeploymentState): boolean {
  return isPreCutover(state);
}

export const Deployment = Type.Object({
  deployment_id: DeploymentId,
  server_id: ServerId,
  from_version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  to_version: Type.Integer({ minimum: 1 }),
  state: DeploymentState,
  candidate_pod: Type.Union([Type.String(), Type.Null()]),
  snapshot_id: Type.Union([Type.String(), Type.Null()]),
  player_visible_ms: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  queue_position: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  approved_by: Type.Union([Type.String(), Type.Null()]),
  initiated_by: Type.String(),
  started_at: Timestamp,
  finished_at: Type.Union([Timestamp, Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
});
export type Deployment = Static<typeof Deployment>;

/**
 * One object per state transition. This is what the CLI writes to stdout under
 * --json and what an agent or a CI job consumes to follow a long deployment,
 * detect a stall, and abort.
 */
export const DeploymentStateEvent = Type.Object({
  event: Type.Literal("deployment_state"),
  deployment_id: DeploymentId,
  server_id: ServerId,
  state: DeploymentState,
  detail: Type.Union([Type.String(), Type.Null()]),
  ts: Timestamp,
});
export type DeploymentStateEvent = Static<typeof DeploymentStateEvent>;

/**
 * A stall report, emitted when a state exceeds its budget without advancing.
 *
 * Contracted rather than declared client side, because it shares the NDJSON
 * stream with DeploymentStateEvent and a consumer parsing that stream receives
 * both. A record the contract package does not define is a record no consumer
 * can rely on.
 */
export const DeploymentStallEvent = Type.Object({
  event: Type.Literal("deployment_stalled"),
  deployment_id: DeploymentId,
  server_id: ServerId,
  state: DeploymentState,
  budget_ms: Type.Integer({ minimum: 0 }),
  elapsed_ms: Type.Integer({ minimum: 0 }),
  /**
   * Where the budget came from. "provisional" means the placeholder table, not a
   * measurement. It stops being the only possible value once M1 lands, so it is
   * a union rather than a literal.
   */
  budget_source: Type.Union([Type.Literal("provisional"), Type.Literal("measured")]),
  policy: Type.Union([Type.Literal("report"), Type.Literal("abort")]),
  ts: Timestamp,
});
export type DeploymentStallEvent = Static<typeof DeploymentStallEvent>;

/** The closing record of a watched deployment. */
export const DeploymentClosedEvent = Type.Object({
  event: Type.Literal("deployment_closed"),
  deployment_id: DeploymentId,
  server_id: ServerId,
  final_state: DeploymentState,
  elapsed_ms: Type.Integer({ minimum: 0 }),
  /** The exact command that undoes this, printed where the owner can see it. */
  rollback_command: Type.String(),
  ts: Timestamp,
});
export type DeploymentClosedEvent = Static<typeof DeploymentClosedEvent>;

/** Every record a --json watch session can write. */
export const DeploymentStreamRecord = Type.Union([
  DeploymentStateEvent,
  DeploymentStallEvent,
  DeploymentClosedEvent,
]);
export type DeploymentStreamRecord = Static<typeof DeploymentStreamRecord>;

/**
 * Per-state stall budgets in milliseconds, used by the CLI --watch loop to tell
 * a slow deployment from a hung one.
 *
 * These are placeholders until Engineer 2 reports the M1 measurement. Any value
 * derived from them must say so rather than presenting a guess as a measurement.
 * See UNMEASURED in preview.ts.
 */
export const PROVISIONAL_STALL_BUDGET_MS: Record<DeploymentState, number | null> = {
  queued: null,
  building: 120_000,
  staging: 180_000,
  presync: 600_000,
  freezing: 300_000,
  verifying: 300_000,
  cutover: 60_000,
  draining: 120_000,
  idle: null,
  aborted: null,
  failed: null,
};

/**
 * HTTP view used by the control-plane API. CamelCase on the wire for Elysia
 * handlers; the TypeBox `Deployment` object above is the locked CLI/MCP seam.
 */
export type DeploymentView = {
  id: string;
  serverId: string;
  state: DeploymentState;
  queuePosition: number | null;
  candidatePod: string | null;
  snapshotId: string | null;
  fromVersion: string | null;
  toVersion: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type VelocityTransfer = {
  transferId: string;
  fromRoute: string;
  toRoute: string;
  message: string;
};

export type VelocityTransferAck = {
  movedPlayers: string[];
  failures: Array<{ player: string; reason: string }>;
};
