import type { WorldEventsRollup } from "@farlands/contracts";

/**
 * Persistence for closed windows.
 *
 * The interface exists so the aggregator can be tested without a database and
 * so the failure contract is stated once, in one place: a store may be slow,
 * unreachable or broken, and none of that is allowed to reach the request path.
 * Telemetry that degrades the game is worse than telemetry that is missing, so
 * every implementation is permitted to reject and none is permitted to be
 * awaited by an ingest handler.
 *
 * The production implementation is Drizzle over `world_events_rollup`
 * (`server_id, window_start, window_end, metrics jsonb`). That table and its
 * migration are requested by pull request rather than written here: migrations
 * are a single sequence with a single owner (Engineer 3), and two engineers
 * writing them in parallel is how a sequence forks.
 *
 * Note what the interface does not have: no method takes or returns a
 * WorldEvent. Raw events grow without bound and nothing reads them, so the
 * only shape that crosses this boundary is an aggregate.
 */
export interface RollupStore {
  /** Persist one closed window. Rejecting is an accepted outcome. */
  put(rollup: WorldEventsRollup): Promise<void>;
  /** Windows already persisted for a server, oldest first. */
  list(serverId: string): Promise<readonly WorldEventsRollup[]>;
}

/**
 * The development and test implementation.
 *
 * It holds rollups in a map keyed by server. The row count grows with elapsed
 * windows, never with event volume, which is the property the no-raw-events
 * rule exists to protect and which the test suite asserts by inspecting this
 * object rather than by reading the aggregator.
 */
export class InMemoryRollupStore implements RollupStore {
  private readonly rows = new Map<string, WorldEventsRollup[]>();

  async put(rollup: WorldEventsRollup): Promise<void> {
    const existing = this.rows.get(rollup.server_id);
    if (existing) existing.push(rollup);
    else this.rows.set(rollup.server_id, [rollup]);
  }

  async list(serverId: string): Promise<readonly WorldEventsRollup[]> {
    return this.rows.get(serverId) ?? [];
  }

  /**
   * Everything the store holds, for tests that must inspect persistence rather
   * than trust a claim about it. Deliberately returns the live contents: a test
   * that asserts "no raw events are stored" has to be able to see everything
   * that is stored, including anything an implementation added by accident.
   */
  contents(): Record<string, readonly WorldEventsRollup[]> {
    return Object.fromEntries(this.rows);
  }

  clear(): void {
    this.rows.clear();
  }
}
