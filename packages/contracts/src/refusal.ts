import { type Static, Type } from "@sinclair/typebox";
import { ContentDigest, ServerId } from "./common.ts";

/**
 * The structured refusal.
 *
 * This is a return value, never a thrown exception: anything that throws gets
 * rendered by some agent framework as a stack trace, and the whole point is that
 * a human reading it over someone's shoulder understands in five seconds why the
 * agent stopped.
 *
 * The same body is returned by the MCP act tools, the CLI deploy and rollback
 * commands, and the deploy endpoint itself. Byte for byte, from this one type.
 */

/**
 * Why the approval check failed. Distinguishing these is a usability decision,
 * not a leak: the caller already holds the token, so telling them it expired
 * reveals nothing they could not determine by waiting.
 */
export const ApprovalRefusalReason = Type.Union([
  Type.Literal("missing"),
  Type.Literal("expired"),
  Type.Literal("consumed"),
  Type.Literal("principal_mismatch"),
  Type.Literal("digest_mismatch"),
]);
export type ApprovalRefusalReason = Static<typeof ApprovalRefusalReason>;

export const ApprovalRequiredRefusal = Type.Object(
  {
    error: Type.Literal("approval_required"),
    reason: ApprovalRefusalReason,
    tool: Type.String({ description: "The tool or command that was refused" }),
    server_id: ServerId,
    rule_set_version: Type.Integer({ minimum: 1 }),
    content_digest: ContentDigest,
    message: Type.String(),
    resolution: Type.String({
      description: "What the caller should do instead. Never 'retry'.",
    }),
  },
  { $id: "ApprovalRequiredRefusal" },
);
export type ApprovalRequiredRefusal = Static<typeof ApprovalRequiredRefusal>;

/**
 * Rate limiting is a different outcome and must be distinguishable from an
 * approval refusal, because the correct next move differs: wait, rather than ask
 * a human.
 */
export const RateLimitedRefusal = Type.Object(
  {
    error: Type.Literal("rate_limited"),
    tool: Type.String(),
    server_id: ServerId,
    limit: Type.Integer({ minimum: 1 }),
    window_seconds: Type.Integer({ minimum: 1 }),
    retry_after_seconds: Type.Integer({ minimum: 0 }),
    message: Type.String(),
    resolution: Type.String(),
  },
  { $id: "RateLimitedRefusal" },
);
export type RateLimitedRefusal = Static<typeof RateLimitedRefusal>;

/**
 * Read tools are scoped to the caller's own servers. Telemetry is a behavioural
 * record of named players, so an out-of-scope read is refused rather than
 * returning an empty result, which would leak existence.
 */
export const NotFoundRefusal = Type.Object(
  {
    error: Type.Literal("not_found"),
    tool: Type.String(),
    resource: Type.String(),
    message: Type.String(),
    resolution: Type.String(),
  },
  { $id: "NotFoundRefusal" },
);
export type NotFoundRefusal = Static<typeof NotFoundRefusal>;

export const Refusal = Type.Union([ApprovalRequiredRefusal, RateLimitedRefusal, NotFoundRefusal]);
export type Refusal = Static<typeof Refusal>;

const REASON_TEXT: Record<ApprovalRefusalReason, string> = {
  missing: "requires an approval token minted by a human against this exact content digest",
  expired: "was approved, but the approval token has expired",
  consumed: "was approved, but that approval token has already been used",
  principal_mismatch: "requires an approval token issued to the calling principal",
  digest_mismatch:
    "carries an approval token minted against different rule content than the version being deployed",
};

const RESOLUTION_TEXT: Record<ApprovalRefusalReason, string> = {
  missing:
    "Ask the server owner to review and approve this version in the dashboard or phone app. Retrying this call without a token will return this same refusal.",
  expired:
    "Approvals are short-lived. Ask the server owner to approve this version again; the previous approval can no longer be redeemed.",
  consumed:
    "Approval tokens are single use, including when the deployment they were spent on later aborted. Ask the server owner for a fresh approval.",
  principal_mismatch:
    "An approval is bound to the principal it was issued to. Ask the server owner to approve this version for the principal making this call.",
  digest_mismatch:
    "The rule content changed after it was approved. A changed rule is a new version, so ask the server owner to review and approve the new version.",
};

/** Build the refusal. One constructor, so every surface returns identical bytes. */
export function approvalRequired(input: {
  reason: ApprovalRefusalReason;
  tool: string;
  server_id: string;
  rule_set_version: number;
  content_digest: string;
}): ApprovalRequiredRefusal {
  return {
    error: "approval_required",
    reason: input.reason,
    tool: input.tool,
    server_id: input.server_id,
    rule_set_version: input.rule_set_version,
    content_digest: input.content_digest,
    message: `Deploying rule set v${input.rule_set_version} to ${input.server_id} ${REASON_TEXT[input.reason]}.`,
    resolution: RESOLUTION_TEXT[input.reason],
  };
}

export function isRefusal(value: unknown): value is Refusal {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "string"
  );
}
