import {
  type ApprovalRefusalReason,
  type ApprovalRequiredRefusal,
  approvalRequired,
  type NotFoundRefusal,
  type RateLimitedRefusal,
  type Refusal,
} from "@farlands/contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolOutcomeKind } from "./logging.ts";
import type { RateLimitVerdict } from "./rate-limit.ts";

/**
 * Outcomes, and how they reach the agent.
 *
 * A refusal is a return value. Anything thrown from a tool body becomes a
 * JSON-RPC error, and a JSON-RPC error is rendered by most agent frameworks as a
 * stack trace with the useful sentence buried in it. The demo is five seconds of
 * someone reading the refusal off a projector, so the refusal has to arrive as
 * content, verbatim, in the tool result.
 *
 * The result is still marked `isError`, because "this call did not do the thing
 * you asked" is true and the model should not read a refusal as a success. That
 * flag lives inside the result: it is a value, not an exception.
 */

export interface ToolOutcome {
  kind: ToolOutcomeKind;
  /** Machine-readable outcome code, mirrored into the tool log. */
  code: string | null;
  body: unknown;
}

export function ok(body: unknown): ToolOutcome {
  return { kind: "ok", code: null, body };
}

export function refused(refusal: Refusal): ToolOutcome {
  return { kind: "refused", code: refusal.error, body: refusal };
}

/**
 * A refusal the API produced in a shape this package cannot rebuild.
 *
 * `create_server` is the case that forces this to exist: the refusal type is
 * keyed to a server id and a rule set version, and a server being created has
 * neither. Rather than inventing plausible values to satisfy the type, the
 * upstream body is passed through untouched and the gap is recorded honestly.
 */
export function refusedUpstream(code: string, body: unknown): ToolOutcome {
  return { kind: "refused", code, body };
}

export function failed(code: string, body: unknown): ToolOutcome {
  return { kind: "error", code, body };
}

/**
 * Out of scope reads are refused, not emptied.
 *
 * Returning an empty result for someone else's server answers the question "does
 * this server exist", and telemetry is a behavioural record of named players, so
 * that question is not ours to answer.
 */
export function notFound(tool: string, resource: string): NotFoundRefusal {
  return {
    error: "not_found",
    tool,
    resource,
    message: `No ${resource} you can see.`,
    resolution:
      "Read tools are scoped to servers you own. Check the id, or ask the owner to grant access.",
  };
}

/**
 * Rate limiting is a different outcome from an approval refusal and says so
 * loudly, because the correct next move differs: wait, rather than ask a human.
 */
export function rateLimited(input: {
  tool: string;
  server_id: string;
  verdict: RateLimitVerdict;
}): RateLimitedRefusal {
  const { limit, window_seconds, retry_after_seconds } = input.verdict;
  const minutes = Math.max(1, Math.ceil(retry_after_seconds / 60));
  return {
    error: "rate_limited",
    tool: input.tool,
    server_id: input.server_id,
    limit,
    window_seconds,
    retry_after_seconds,
    message: `${input.tool} is limited to ${limit} calls per ${window_seconds} seconds per server, and this caller has used them.`,
    resolution: `No approval is needed and nothing was refused for safety reasons. Wait about ${minutes} minute(s) and call again, or work with the versions already drafted.`,
  };
}

const APPROVAL_REASONS: readonly ApprovalRefusalReason[] = [
  "missing",
  "expired",
  "consumed",
  "principal_mismatch",
  "digest_mismatch",
];

/**
 * Rebuild an approval refusal the API returned, through the contract
 * constructor.
 *
 * The MCP server never decides whether a token is good; it forwards the token
 * and reports what came back. Passing the API's fields back through
 * `approvalRequired()` means the bytes an agent sees here are the same bytes the
 * CLI prints and the same bytes the deploy endpoint returned, even if some
 * surface's wording drifts later.
 */
export function approvalRefusalFrom(body: unknown, tool: string): ApprovalRequiredRefusal | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as Record<string, unknown>;
  if (candidate.error !== "approval_required") return null;

  const reason = candidate.reason;
  if (typeof reason !== "string") return null;
  if (!APPROVAL_REASONS.includes(reason as ApprovalRefusalReason)) return null;

  const serverId = candidate.server_id;
  const version = candidate.rule_set_version;
  const digest = candidate.content_digest;
  if (typeof serverId !== "string") return null;
  if (typeof version !== "number") return null;
  if (typeof digest !== "string") return null;

  return approvalRequired({
    reason: reason as ApprovalRefusalReason,
    tool,
    server_id: serverId,
    rule_set_version: version,
    content_digest: digest,
  });
}

export function notFoundRefusalFrom(
  body: unknown,
  tool: string,
  resource: string,
): NotFoundRefusal {
  if (typeof body === "object" && body !== null) {
    const candidate = body as Record<string, unknown>;
    if (
      candidate.error === "not_found" &&
      typeof candidate.resource === "string" &&
      typeof candidate.message === "string" &&
      typeof candidate.resolution === "string"
    ) {
      return {
        error: "not_found",
        tool,
        resource: candidate.resource,
        message: candidate.message,
        resolution: candidate.resolution,
      };
    }
  }
  return notFound(tool, resource);
}

export function toCallToolResult(outcome: ToolOutcome): CallToolResult {
  return {
    content: [{ type: "text", text: `${JSON.stringify(outcome.body, null, 2)}\n` }],
    isError: outcome.kind !== "ok",
  };
}
