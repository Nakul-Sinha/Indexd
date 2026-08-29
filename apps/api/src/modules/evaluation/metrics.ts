import type { RollupMetrics, WorldEventsRollup } from "@farlands/contracts";

/**
 * Arithmetic over rollups: merging the windows on one side of a deployment, and
 * the per-metric difference between the two sides.
 *
 * Everything here is subtraction. There is no test statistic, no threshold and
 * no ranking, because the row this feeds has no field for one and the sample
 * could not support one if it did.
 */

/** The integer counters, which merge by addition and difference by subtraction. */
const COUNTER_KEYS = [
  "joins",
  "leaves",
  "deaths",
  "blocks_placed",
  "blocks_broken",
  "chat_messages",
] as const satisfies readonly (keyof RollupMetrics)[];

export type CounterKey = (typeof COUNTER_KEYS)[number];

export interface MergedWindow {
  start: string;
  end: string;
  metrics: RollupMetrics;
  /** How many rollup windows were folded in. One is the exact case. */
  windows: number;
}

/**
 * Fold several consecutive rollups into one window's metrics.
 *
 * Three fields cannot be added and each is handled the way that understates
 * rather than overstates:
 *
 *   - `unique_players` is a count of a set whose members the rollup deliberately
 *     discarded, so the sets cannot be unioned. The maximum across windows is a
 *     lower bound on the distinct people seen; a sum would count one player once
 *     per window they appeared in, which for this fixture is 51 people who do
 *     not exist.
 *   - `mean_session_seconds` is a mean the rollup carries without the count it
 *     was taken over, so windows are weighted equally. With one window a side,
 *     which is the ordinary case, that is exact.
 *   - `seconds_in_region` is a per-region total and does add, but only over the
 *     regions actually present. A region absent from a window recorded no time
 *     there, which is a zero rather than a gap.
 */
export function mergeRollups(rollups: readonly WorldEventsRollup[]): MergedWindow | null {
  if (rollups.length === 0) return null;

  const ordered = [...rollups].sort(
    (a, b) => Date.parse(a.window_start) - Date.parse(b.window_start),
  );
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first === undefined || last === undefined) return null;

  const counters: Record<CounterKey, number> = {
    joins: 0,
    leaves: 0,
    deaths: 0,
    blocks_placed: 0,
    blocks_broken: 0,
    chat_messages: 0,
  };
  let uniquePlayers = 0;
  const regions = new Map<string, number>();
  let meanSum = 0;
  let meanWindows = 0;

  for (const rollup of ordered) {
    for (const key of COUNTER_KEYS) counters[key] += rollup.metrics[key];
    uniquePlayers = Math.max(uniquePlayers, rollup.metrics.unique_players);
    for (const [region, seconds] of Object.entries(rollup.metrics.seconds_in_region)) {
      regions.set(region, (regions.get(region) ?? 0) + seconds);
    }
    if (rollup.metrics.mean_session_seconds !== null) {
      meanSum += rollup.metrics.mean_session_seconds;
      meanWindows += 1;
    }
  }

  return {
    start: first.window_start,
    end: last.window_end,
    windows: ordered.length,
    metrics: {
      ...counters,
      unique_players: uniquePlayers,
      // Null means not measurable, exactly as it does on a single window. A
      // zero would say every session was instantaneous.
      mean_session_seconds: meanWindows === 0 ? null : meanSum / meanWindows,
      seconds_in_region: Object.fromEntries(regions),
    },
  };
}

/**
 * The per-metric change, after minus before.
 *
 * A metric that was not measurable on one side is absent from the result rather
 * than present as zero: absent reads as "no measurement", zero reads as "no
 * change", and the whole point of the row is that a reader can tell those apart.
 */
export function metricDelta(before: RollupMetrics, after: RollupMetrics): Record<string, number> {
  const delta: Record<string, number> = {};

  for (const key of COUNTER_KEYS) delta[key] = after[key] - before[key];
  delta.unique_players = after.unique_players - before.unique_players;

  if (before.mean_session_seconds !== null && after.mean_session_seconds !== null) {
    delta.mean_session_seconds = after.mean_session_seconds - before.mean_session_seconds;
  }

  // Regions are keyed rather than flattened into one number, because a rule
  // aimed at one region moves that region and a total would hide it.
  const regions = new Set([
    ...Object.keys(before.seconds_in_region),
    ...Object.keys(after.seconds_in_region),
  ]);
  for (const region of [...regions].sort()) {
    delta[`seconds_in_region.${region}`] =
      (after.seconds_in_region[region] ?? 0) - (before.seconds_in_region[region] ?? 0);
  }

  return delta;
}

/**
 * The two n's the row reports, counted across both windows.
 *
 * Both are lower bounds and the row says so through
 * CONFOUND_NOTES.counts_are_lower_bounds. `n_players` takes the largest
 * per-window count because identities are gone; `n_sessions` counts joins,
 * which misses anyone already online when the first window opened.
 */
export function countSample(
  before: MergedWindow,
  after: MergedWindow,
): { n_players: number; n_sessions: number } {
  return {
    n_players: Math.max(before.metrics.unique_players, after.metrics.unique_players),
    n_sessions: before.metrics.joins + after.metrics.joins,
  };
}
