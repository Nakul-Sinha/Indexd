import type { WorldEventsRollup } from "@farlands/contracts";
import { type MergedWindow, mergeRollups } from "./metrics.ts";

/**
 * Choosing the before and after windows around one cutover.
 *
 * Window boundaries are set by the aggregator, aligned to absolute time, so the
 * two sides are comparable across restarts and across batch sizes. Nothing here
 * re-cuts them; it selects among them.
 */

export interface WindowSelection {
  before: MergedWindow;
  after: MergedWindow;
  /** Windows that spanned the cutover and were used by neither side. */
  straddling: number;
}

export type WindowSelectionFailure =
  | { ok: false; reason: "no_telemetry_before" }
  | { ok: false; reason: "no_telemetry_after" };

export type WindowSelectionResult = ({ ok: true } & WindowSelection) | WindowSelectionFailure;

export interface WindowSelectionOptions {
  /**
   * How far either side of the cutover to reach. Both sides use the same span,
   * because a longer after-window collects more of everything and the delta
   * would be reading the clock rather than the rule change.
   */
  spanMs: number;
}

/** A day either side, which is the largest span a weekend's play makes sense over. */
export const DEFAULT_SPAN_MS = 24 * 60 * 60 * 1000;

/**
 * Split a server's rollups into the window before the cutover and the window
 * after it.
 *
 * A rollup that contains the cutover instant is discarded rather than assigned.
 * It holds play under both rule sets, so counting it on either side attributes
 * some of the old rules' effect to the new ones. Discarding it costs one window
 * of data and is recorded as a confound rather than silently absorbed.
 */
export function selectWindows(
  rollups: readonly WorldEventsRollup[],
  cutoverAt: string,
  options: WindowSelectionOptions = { spanMs: DEFAULT_SPAN_MS },
): WindowSelectionResult {
  const cutoverMs = Date.parse(cutoverAt);
  if (Number.isNaN(cutoverMs)) throw new TypeError(`cutoverAt is not a timestamp: ${cutoverAt}`);

  const earliest = cutoverMs - options.spanMs;
  const latest = cutoverMs + options.spanMs;

  const before: WorldEventsRollup[] = [];
  const after: WorldEventsRollup[] = [];
  let straddling = 0;

  for (const rollup of rollups) {
    const startMs = Date.parse(rollup.window_start);
    const endMs = Date.parse(rollup.window_end);

    // Half-open windows: [start, end). A window ending exactly at the cutover
    // holds no play under the new rules, so it belongs entirely to before.
    if (endMs <= cutoverMs) {
      if (endMs > earliest) before.push(rollup);
      continue;
    }
    if (startMs >= cutoverMs) {
      if (startMs < latest) after.push(rollup);
      continue;
    }
    straddling += 1;
  }

  const mergedBefore = mergeRollups(before);
  if (mergedBefore === null) return { ok: false, reason: "no_telemetry_before" };
  const mergedAfter = mergeRollups(after);
  if (mergedAfter === null) return { ok: false, reason: "no_telemetry_after" };

  return { ok: true, before: mergedBefore, after: mergedAfter, straddling };
}
