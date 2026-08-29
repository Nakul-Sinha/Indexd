import { DRAFT_RATE_LIMIT } from "@farlands/contracts";

/**
 * The draft-tool rate limiter.
 *
 * Draft tools have no live effect, which is exactly why they are the easy ones
 * to call in a loop. They invoke a model and append durable rows, so the cost of
 * a loop is real even though the blast radius is not. The limit exists to bound
 * that cost, and it is enforced here rather than in the client because a client
 * side limit is a suggestion.
 */

export interface RateLimitVerdict {
  allowed: boolean;
  limit: number;
  window_seconds: number;
  /** Seconds until the oldest call in the window ages out. Zero when allowed. */
  retry_after_seconds: number;
}

export interface RateLimiter {
  /** Record one call against `key` and say whether it is permitted. */
  consume(key: string): Promise<RateLimitVerdict>;
}

/** Draft limits are scoped per principal and per server, per DRAFT_RATE_LIMIT.scope. */
export function draftRateLimitKey(principal: string, serverId: string): string {
  return `${principal}:${serverId}`;
}

export interface InMemoryRateLimiterOptions {
  limit?: number;
  windowSeconds?: number;
  now?: () => number;
}

/**
 * The in-memory implementation.
 *
 * This is correct for a single process and wrong for a deployment. An in-memory
 * counter is per replica, so with N replicas behind a load balancer the caller
 * gets N times the configured limit, and a limit you can multiply by scaling the
 * service is not a limit. The real implementation is Postgres backed: a counter
 * row keyed by (principal, server_id, window) incremented in the same
 * transaction that writes the draft, so the limit and the row it bounds cannot
 * disagree. This class exists behind the interface so that swap is one line at
 * the composition root and nothing else moves.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly calls = new Map<string, number[]>();

  constructor(options: InMemoryRateLimiterOptions = {}) {
    this.limit = options.limit ?? DRAFT_RATE_LIMIT.calls;
    this.windowMs = (options.windowSeconds ?? DRAFT_RATE_LIMIT.window_seconds) * 1000;
    this.now = options.now ?? Date.now;
  }

  async consume(key: string): Promise<RateLimitVerdict> {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.calls.get(key) ?? []).filter((at) => at > cutoff);

    const windowSeconds = Math.round(this.windowMs / 1000);
    if (recent.length >= this.limit) {
      // Keep the pruned window so a caller cannot extend it by calling again.
      this.calls.set(key, recent);
      const oldest = recent[0] ?? now;
      const retryAfterMs = Math.max(0, oldest + this.windowMs - now);
      return {
        allowed: false,
        limit: this.limit,
        window_seconds: windowSeconds,
        retry_after_seconds: Math.ceil(retryAfterMs / 1000),
      };
    }

    recent.push(now);
    this.calls.set(key, recent);
    return {
      allowed: true,
      limit: this.limit,
      window_seconds: windowSeconds,
      retry_after_seconds: 0,
    };
  }
}

/** A limiter that permits everything, for surfaces that do not draft. */
export const unlimited: RateLimiter = {
  async consume() {
    return {
      allowed: true,
      limit: DRAFT_RATE_LIMIT.calls,
      window_seconds: DRAFT_RATE_LIMIT.window_seconds,
      retry_after_seconds: 0,
    };
  },
};
