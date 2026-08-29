/**
 * Join/leave pairing, and the two boundary decisions it forces.
 *
 * `mean_session_seconds` is the only metric in the rollup that is not a count,
 * and it is the one the Director reasons about when it asks whether a rule
 * change made people stay. Getting the boundary rules wrong does not produce an
 * error; it produces a number that is quietly wrong in a fixed direction, which
 * is worse. So both rules are stated here, implemented here, and tested.
 *
 * Decision 1: a session still open when a window closes is excluded from that
 * window and carried forward. It is not truncated at the boundary, because a
 * truncated length measures when the window happened to end and not how long
 * anybody played. Truncation also biases every mean downward by an amount that
 * depends on window alignment, so a before/after comparison would show a
 * "change" caused by nothing but the clock. The open join is kept in this
 * ledger, which outlives window rotation, and the full duration is credited to
 * the window in which the session actually closed. That matches the contract
 * comment on the field exactly: sessions that closed in the window.
 *
 * Decision 2: a leave with no join in the ledger contributes to `leaves` but
 * not to `mean_session_seconds`. The leave was observed, so counting it is
 * honest; the start was not, so any duration would be invented. Assuming the
 * window start is the tempting answer and it is wrong, because it manufactures
 * short sessions out of players who were already online when ingest began, and
 * it does so most often right after a deployment, which is precisely when the
 * number is being read.
 *
 * The ledger holds one timestamp per currently open player. It is bounded by
 * concurrent players, not by events, which is what keeps it compatible with the
 * no-raw-events rule.
 */

/** A join older than this is presumed lost rather than still open. */
export const DEFAULT_MAX_SESSION_SECONDS = 12 * 60 * 60;

export class SessionLedger {
  private readonly openJoins = new Map<string, number>();

  constructor(private readonly maxSessionMs = DEFAULT_MAX_SESSION_SECONDS * 1000) {}

  /**
   * Record a join.
   *
   * A second join for a player already open means the matching leave was
   * dropped in transit. The later join wins: pairing the eventual leave with
   * the older join would report one long session where there were two, and of
   * the two available guesses that is the one that inflates the metric.
   */
  open(player: string, atMs: number): void {
    this.openJoins.set(player, atMs);
  }

  /** Session length in seconds, or null when this leave has no join to pair with. */
  close(player: string, atMs: number): number | null {
    const startedAt = this.openJoins.get(player);
    if (startedAt === undefined) return null;
    this.openJoins.delete(player);
    // Clock skew between emitter batches can put a leave marginally before its
    // join. Clamping to zero keeps the mean defined; a negative session length
    // would be nonsense and dropping it would lose a real session.
    return Math.max(0, (atMs - startedAt) / 1000);
  }

  /**
   * Drop joins too old to still be open.
   *
   * Without this the ledger is the unbounded collection the no-raw-events rule
   * exists to prevent: a player whose leave event is lost would sit in memory
   * until the process restarts. Called on window rotation, so the cost is paid
   * per window rather than per event.
   */
  prune(nowMs: number): number {
    let dropped = 0;
    for (const [player, startedAt] of this.openJoins) {
      if (nowMs - startedAt > this.maxSessionMs) {
        this.openJoins.delete(player);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Currently open sessions. Exposed so tests can assert the ledger stays bounded. */
  get openCount(): number {
    return this.openJoins.size;
  }
}
