/**
 * One proposal per server per hour.
 *
 * The reason is a product truth rather than a cost control, and the difference
 * changes where the limit belongs. A world that changes constantly is not alive,
 * it is unstable; the Director's value is an occasional good idea, not a stream
 * of notifications an owner learns to swipe away. A cost limit could live in the
 * scheduler and be relaxed when spend allowed it. This one cannot, because the
 * thing it protects is what the world feels like to play on.
 *
 * So it is derived from the proposal rows themselves rather than counted
 * alongside them. An in-memory counter is per replica, which means N replicas
 * grant N times the limit, and a limit that scaling multiplies is not a limit.
 * The newest row for a server is the durable record of the last time an owner
 * was asked, so reading it is the one form of this check that cannot disagree
 * with the thing it bounds, and it survives a restart without any state of its
 * own.
 *
 * Note what the window is measured from: every proposal, not every accepted one.
 * A rejected proposal still cost the owner a decision, so it still starts the
 * hour.
 */

export const PROPOSAL_INTERVAL_SECONDS = 3600;

export interface ProposalWindowVerdict {
  allowed: boolean;
  interval_seconds: number;
  /** Seconds until the server is eligible again. Zero when allowed. */
  retry_after_seconds: number;
}

/**
 * Decide whether a server may be proposed to right now.
 *
 * `latestCreatedAt` is the newest proposal's timestamp, or null when the server
 * has never had one. An unparseable timestamp is treated as no proposal: the
 * alternative is to refuse forever on one bad row, and a stuck Director is a
 * worse failure than an extra proposal.
 */
export function proposalWindow(
  latestCreatedAt: string | null,
  nowMs: number,
  intervalSeconds: number = PROPOSAL_INTERVAL_SECONDS,
): ProposalWindowVerdict {
  const intervalMs = intervalSeconds * 1000;
  const lastMs = latestCreatedAt === null ? Number.NaN : Date.parse(latestCreatedAt);

  if (Number.isNaN(lastMs)) {
    return { allowed: true, interval_seconds: intervalSeconds, retry_after_seconds: 0 };
  }

  const elapsedMs = nowMs - lastMs;
  if (elapsedMs >= intervalMs) {
    return { allowed: true, interval_seconds: intervalSeconds, retry_after_seconds: 0 };
  }

  return {
    allowed: false,
    interval_seconds: intervalSeconds,
    // Rounded up, so a caller that waits exactly this long is past the boundary
    // rather than one millisecond short of it and refused a second time.
    retry_after_seconds: Math.ceil((intervalMs - elapsedMs) / 1000),
  };
}
