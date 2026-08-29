import type { ExperimentDesign } from "@farlands/contracts";

/**
 * The notes an experiment row may carry, as a closed set.
 *
 * `Experiment.notes` is typed as free text, which is the one place a verdict
 * could be smuggled into a record that has no field for one. A caller that can
 * only pass tags from this table cannot write "the Director came out ahead" into
 * a row, so the guarantee is a type rather than a review comment.
 *
 * Every string here is a limit of the measurement. None of them is a finding.
 */
export const CONFOUND_NOTES = {
  order_effects:
    "Order effects: the arms ran one after another, so anything that changed with time changed with the arm.",
  time_of_day:
    "Time of day: the windows sit at different clock times, and play patterns differ across an evening.",
  novelty:
    "Novelty: a rule change is interesting because it is new, and interest decays on its own.",
  player_memory:
    "Player memory: players remember the earlier arm. No snapshot restore resets what they already learned.",
  friend_group_sample: "Sample: a friend group's worth of players and sessions, not a population.",
  straddling_window_dropped:
    "One or more rollup windows spanned the cutover instant and were dropped from both sides, because a window holding play under two rule sets belongs to neither.",
  counts_are_lower_bounds:
    "n_players and n_sessions are lower bounds: rollups carry per-window counts rather than identities, and a player already online when a window opened has no join in it.",
  unweighted_window_means:
    "mean_session_seconds across several windows is an unweighted mean of window means, because a rollup carries the mean and not how many sessions closed.",
  single_server:
    "One server: everything that is true of this server and its owner is uncontrolled.",
  split_population_unverified:
    "The population split across the two servers was not verified to be balanced on anything.",
} as const;

export type ConfoundTag = keyof typeof CONFOUND_NOTES;

export const CONFOUND_TAGS = Object.keys(CONFOUND_NOTES) as readonly ConfoundTag[];

/**
 * What each design is uncontrolled for before a caller adds anything.
 *
 * These attach automatically. A caller who forgets to name a confound still
 * publishes one, which is the reason the list lives here and not at the callsite.
 *
 * `parallel` drops order effects and player memory because a split population
 * never sees the other arm, and it keeps the sample-size limit because two small
 * servers are still two small servers.
 */
export const DESIGN_CONFOUNDS: Record<ExperimentDesign, readonly ConfoundTag[]> = {
  pre_post: [
    "order_effects",
    "time_of_day",
    "novelty",
    "player_memory",
    "friend_group_sample",
    "single_server",
  ],
  parallel: ["time_of_day", "novelty", "friend_group_sample", "split_population_unverified"],
};

/** `Experiment.notes` has a 2000 character ceiling; the joined text stays under it. */
export const MAX_NOTES_LENGTH = 2000;

/**
 * Render tags to the text stored in `notes`.
 *
 * Order follows CONFOUND_NOTES rather than the order tags arrived in, so two
 * rows listing the same confounds are byte-identical and a diff between rows
 * means the confounds actually differ.
 */
export function renderNotes(tags: readonly ConfoundTag[]): string | null {
  const selected = new Set(tags);
  const lines = CONFOUND_TAGS.filter((tag) => selected.has(tag)).map((tag) => CONFOUND_NOTES[tag]);
  if (lines.length === 0) return null;
  const text = lines.join("\n");
  return text.length <= MAX_NOTES_LENGTH ? text : text.slice(0, MAX_NOTES_LENGTH);
}
