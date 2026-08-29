import { type Static, Type } from "@sinclair/typebox";
import { ContentDigest, ServerId, Timestamp } from "./common.ts";
import { Deployment, DeploymentState } from "./deployment.ts";
import { RuleDiff, RuleSetVersion } from "./rules.ts";

/**
 * Request and response pairs for the HTTP surface. Elysia validates routes with
 * these objects directly, so a route cannot accept a body its contract forbids.
 */

export const ServerSummary = Type.Object({
  server_id: ServerId,
  name: Type.String(),
  hostname: Type.String({ description: "Stable public address, safe to share" }),
  state: Type.Union([
    Type.Literal("running"),
    Type.Literal("stopped"),
    Type.Literal("starting"),
    Type.Literal("deploying"),
  ]),
  player_count: Type.Integer({ minimum: 0 }),
  max_players: Type.Integer({ minimum: 0 }),
  tps: Type.Union([Type.Number({ minimum: 0, maximum: 20 }), Type.Null()]),
  current_version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  regions: Type.Array(Type.String()),
});
export type ServerSummary = Static<typeof ServerSummary>;

/**
 * The sentinel for an estimate that has no measurement behind it yet.
 *
 * The player-visible window is delta sync plus a Paper cold boot, and that
 * number comes from the M1 measurement. Until Engineer 2 reports it, every
 * surface says so in this exact form. A plausible guess here would be worse than
 * an admission, because it would be quoted back as though it were measured.
 */
export const UNMEASURED = "unmeasured" as const;

export const EstimatedWindow = Type.Union([
  Type.Object({
    measured: Type.Literal(true),
    player_visible_ms: Type.Integer({ minimum: 0 }),
    measured_at: Timestamp,
  }),
  Type.Object({
    measured: Type.Literal(false),
    player_visible_ms: Type.Literal(UNMEASURED),
    note: Type.String(),
  }),
]);
export type EstimatedWindow = Static<typeof EstimatedWindow>;

export const UNMEASURED_WINDOW: EstimatedWindow = {
  measured: false,
  player_visible_ms: UNMEASURED,
  note: "The freeze window has not been measured on a realistic world yet (milestone M1).",
};

export const AuthorRulesRequest = Type.Object({
  prompt: Type.String({ minLength: 1, maxLength: 4000 }),
});
export type AuthorRulesRequest = Static<typeof AuthorRulesRequest>;

export const AuthorRulesResponse = Type.Object({
  version: RuleSetVersion,
  diff: RuleDiff,
  attempts: Type.Integer({ minimum: 1, maximum: 3 }),
});
export type AuthorRulesResponse = Static<typeof AuthorRulesResponse>;

/** A drafting failure is a first-class outcome, not an exception. */
export const AuthorRulesFailure = Type.Object({
  error: Type.Literal("authoring_failed"),
  prompt: Type.String(),
  attempts: Type.Integer({ minimum: 1, maximum: 3 }),
  last_candidate: Type.Unknown(),
  validation_errors: Type.Array(
    Type.Object({
      path: Type.String(),
      code: Type.String(),
      message: Type.String(),
      hint: Type.Optional(Type.String()),
    }),
  ),
  message: Type.String(),
});
export type AuthorRulesFailure = Static<typeof AuthorRulesFailure>;

export const PreviewDeployResponse = Type.Object({
  server_id: ServerId,
  from_version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  to_version: Type.Integer({ minimum: 1 }),
  content_digest: ContentDigest,
  diff: RuleDiff,
  estimated_window: EstimatedWindow,
  quota_impact: Type.Object({
    candidate_cpu_millicores: Type.Integer({ minimum: 0 }),
    candidate_memory_mib: Type.Integer({ minimum: 0 }),
    candidate_storage_mib: Type.Integer({ minimum: 0 }),
    headroom_available: Type.Boolean(),
  }),
  rollback_target: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
});
export type PreviewDeployResponse = Static<typeof PreviewDeployResponse>;

export const DeployRequest = Type.Object({
  rule_set_version: Type.Integer({ minimum: 1 }),
  approval_token: Type.Optional(Type.String()),
});
export type DeployRequest = Static<typeof DeployRequest>;

export const DeployResponse = Type.Object({
  deployment: Deployment,
});
export type DeployResponse = Static<typeof DeployResponse>;

export const AbortResponse = Type.Object({
  deployment_id: Type.String(),
  state: DeploymentState,
  /** True when the deployment had already passed cutover and abort was a no-op. */
  no_op: Type.Boolean(),
});
export type AbortResponse = Static<typeof AbortResponse>;

export const MintApprovalRequest = Type.Object({
  server_id: ServerId,
  rule_set_version: Type.Integer({ minimum: 1 }),
  content_digest: ContentDigest,
  issued_to: Type.String({ description: "The principal permitted to redeem this token" }),
});
export type MintApprovalRequest = Static<typeof MintApprovalRequest>;

export const MintApprovalResponse = Type.Object({
  /** Returned once, at mint time. Only the SHA-256 hash is ever stored. */
  token: Type.String(),
  expires_at: Timestamp,
  content_digest: ContentDigest,
});
export type MintApprovalResponse = Static<typeof MintApprovalResponse>;
