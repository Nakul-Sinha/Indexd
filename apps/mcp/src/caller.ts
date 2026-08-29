import { createHash } from "node:crypto";
import { TOKEN_PREFIX } from "@farlands/contracts";

/**
 * Who is calling, as far as this process is allowed to claim.
 *
 * The MCP server deliberately knows very little about identity. It holds a
 * machine token and forwards it; the API decides what that token can see. That
 * split matters because scoping a read is a privacy decision and there must be
 * exactly one place it is made. A second opinion here would eventually disagree
 * with the first, and the disagreement would be silent.
 *
 * The principal is therefore a label, not an authorization: it names the caller
 * in the tool log and keys the draft rate limiter. Nothing reads it to decide
 * whether an operation is permitted.
 */

export type TransportKind = "stdio" | "http";

export interface Caller {
  /** Stable label for logging and rate limiting. Never an authorization decision. */
  principal: string;
  /** The machine token, forwarded verbatim to the API. Null only in tests and local dev. */
  token: string | null;
  transport: TransportKind;
}

/**
 * A short, stable, non-reversible label for a token holder.
 *
 * Rate limit buckets and log lines both need a caller key that survives across
 * calls. Using the token itself would put a live credential in every log line,
 * so the fingerprint stands in for it.
 */
export function machineTokenFingerprint(token: string): string {
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  return `mt_${hash.slice(0, 12)}`;
}

export function isMachineToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX.machine) && value.length > TOKEN_PREFIX.machine.length;
}

/** Pull `Authorization: Bearer flk_...` apart. Returns null when there is nothing usable. */
export function machineTokenFromAuthorization(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  if (!token) return null;
  return isMachineToken(token) ? token : null;
}

export function httpCaller(token: string, principal?: string): Caller {
  return {
    principal: principal ?? machineTokenFingerprint(token),
    token,
    transport: "http",
  };
}

/**
 * The stdio caller comes from the environment, because a stdio server is one
 * agent on one machine acting as one principal for the life of the process.
 */
export function stdioCallerFromEnv(env: Record<string, string | undefined>): Caller {
  const token = env.FARLANDS_MACHINE_TOKEN ?? null;
  const principal =
    env.FARLANDS_PRINCIPAL ?? (token ? machineTokenFingerprint(token) : "anonymous");
  return { principal, token, transport: "stdio" };
}
