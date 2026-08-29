import type { ApiClient, ApiResult } from "../api-client.ts";
import type { Caller } from "../caller.ts";
import type { RateLimiter } from "../rate-limit.ts";
import { failed, notFoundRefusalFrom, refused, type ToolOutcome } from "../results.ts";

/**
 * What a tool body is given, and the handful of shared decisions every tool
 * makes about an API response.
 */

export interface ToolContext {
  caller: Caller;
  api: ApiClient;
  limiter: RateLimiter;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
) => Promise<ToolOutcome>;

/**
 * An API failure that is not a refusal, reported as a value.
 *
 * Nothing here throws. An act tool that cannot reach the API has to fail closed
 * and say so in a sentence, not raise something an agent framework will render
 * as a stack trace.
 */
export function upstreamFailure(tool: string, result: ApiResult): ToolOutcome {
  const unreachable = result.status === 0;
  return failed(unreachable ? "upstream_unreachable" : "upstream_error", {
    error: unreachable ? "upstream_unreachable" : "upstream_error",
    tool,
    status: result.status,
    message: unreachable
      ? `${tool} could not reach the control plane API, so nothing was attempted.`
      : `The control plane API answered ${result.status} for ${tool} and the call did not complete.`,
    resolution:
      "Nothing was changed. This is not an approval problem: check the API is reachable and healthy, then call again.",
    detail: result.body,
  });
}

/** True when the API answered with the contract's own not-found refusal. */
export function isContractNotFound(body: unknown): boolean {
  const record = asRecord(body);
  return record?.error === "not_found";
}

/**
 * Turn an out of scope or missing resource into a refusal.
 *
 * A 403 is treated exactly like a 404 on purpose. Telling a caller that a server
 * exists but is not theirs answers a question about someone else's world, and
 * `get_world_telemetry` makes that question a question about named players.
 *
 * A bare 404 with no contract body is reported as an upstream failure instead,
 * because it is as likely to be a route that does not exist as a resource the
 * caller cannot see. Guessing wrong in that direction would either invent a
 * privacy story or dress an outage up as a scoping decision.
 */
export function refuseUnreadable(
  result: ApiResult,
  tool: string,
  resource: string,
): ToolOutcome | null {
  if (result.status === 403 || (result.status === 404 && isContractNotFound(result.body))) {
    return refused(notFoundRefusalFrom(result.body, tool, resource));
  }
  if (!result.ok) return upstreamFailure(tool, result);
  return null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asItems(value: unknown): unknown[] {
  const record = asRecord(value);
  const items = record?.items;
  return Array.isArray(items) ? items : [];
}
