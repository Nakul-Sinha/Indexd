import {
  EXPERIMENT_CONFOUND_NOTICE,
  type Experiment,
  ExperimentArm,
  type ExperimentDesign,
  type RollupMetrics,
} from "@farlands/contracts";

/**
 * Rendering an experiment row for a human.
 *
 * The rule this file exists to hold: the report is the row, with the confound
 * notice attached, and nothing else. Nothing is computed at rendering time,
 * because a number that appears only in a report is a claim the record does not
 * contain and cannot be checked against.
 *
 * `EXPERIMENT_CONFOUND_NOTICE` is imported from the contracts package rather
 * than written here. It is a constant precisely so that every surface carries
 * the same text and no surface can quietly drop it: a report is not a valid
 * report without it, which is why it is a required field of the object below
 * rather than a footer a caller may forget to print.
 *
 * There is no branch on `arm` anywhere in this file, and no arm name appears in
 * it. The order arms are listed in is read from the contract's own union at
 * load time. A rendering that treated the baseline arm differently from the
 * Director arm would make the comparison meaningless, so the arms are not
 * distinguishable to this code at all.
 */

export interface ExperimentReport {
  experiment_id: string;
  design: ExperimentDesign;
  arm: ExperimentArm;
  server_id: string;
  deployment_id: string;
  rule_version: number;
  window_before: { start: string; end: string };
  window_after: { start: string; end: string };
  metrics_before: RollupMetrics;
  metrics_after: RollupMetrics;
  /** Per-metric change, after minus before. Reported as-is. */
  delta: Record<string, number>;
  n_players: number;
  n_sessions: number;
  notes: string | null;
  /** Always EXPERIMENT_CONFOUND_NOTICE. Required, so it travels with the numbers. */
  confound_notice: string;
}

/**
 * The complete field list, exported so a test can assert the shape rather than
 * sample it. A field added to a report is a field somebody has to justify.
 */
export const REPORT_KEYS = [
  "experiment_id",
  "design",
  "arm",
  "server_id",
  "deployment_id",
  "rule_version",
  "window_before",
  "window_after",
  "metrics_before",
  "metrics_after",
  "delta",
  "n_players",
  "n_sessions",
  "notes",
  "confound_notice",
] as const satisfies readonly (keyof ExperimentReport)[];

/**
 * Arm order, read from the contract union at load time.
 *
 * Listing order is the one place a rendering could imply a ranking, so it is
 * taken from the declaration and never from a metric. Restating the names here
 * would let the two drift; reading them means the report lists exactly the arms
 * the contract knows about, in the order it declares them.
 */
export const ARM_ORDER: readonly ExperimentArm[] = ExperimentArm.anyOf.map(
  (member) => member.const,
);

export function renderReport(experiment: Experiment): ExperimentReport {
  return {
    experiment_id: experiment.experiment_id,
    design: experiment.design,
    arm: experiment.arm,
    server_id: experiment.server_id,
    deployment_id: experiment.deployment_id,
    rule_version: experiment.rule_version,
    window_before: experiment.window_before,
    window_after: experiment.window_after,
    metrics_before: experiment.metrics_before,
    metrics_after: experiment.metrics_after,
    delta: experiment.delta,
    n_players: experiment.n_players,
    n_sessions: experiment.n_sessions,
    notes: experiment.notes,
    confound_notice: EXPERIMENT_CONFOUND_NOTICE,
  };
}

/** Signed, so a reader sees direction without the renderer having to say it. */
function signed(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

/**
 * One report as text.
 *
 * Metrics are listed alphabetically. Sorting by magnitude would put the largest
 * movement at the top, which is a ranking dressed as a layout, and on a friend
 * group's worth of sessions the largest movement is as likely to be noise as
 * anything else.
 */
export function renderReportText(experiment: Experiment): string {
  const report = renderReport(experiment);
  const lines: string[] = [
    `experiment ${report.experiment_id}`,
    `  server ${report.server_id}  deployment ${report.deployment_id}  rule version ${report.rule_version}`,
    `  design ${report.design}  arm ${report.arm}`,
    `  before ${report.window_before.start} to ${report.window_before.end}`,
    `  after  ${report.window_after.start} to ${report.window_after.end}`,
    `  n_players ${report.n_players}  n_sessions ${report.n_sessions}`,
    "  delta:",
  ];

  const keys = Object.keys(report.delta).sort();
  if (keys.length === 0) lines.push("    (nothing measurable on both sides)");
  for (const key of keys) {
    lines.push(`    ${key}: ${signed(report.delta[key] ?? 0)}`);
  }

  if (report.notes !== null) {
    lines.push("  notes:");
    for (const note of report.notes.split("\n")) lines.push(`    ${note}`);
  }

  lines.push(`  ${report.confound_notice}`);
  return lines.join("\n");
}

export interface ArmSection {
  arm: ExperimentArm;
  reports: ExperimentReport[];
}

export interface ExperimentReportSet {
  /** One section per arm the contract declares, in the contract's order. */
  arms: ArmSection[];
  confound_notice: string;
}

/**
 * Rows bucketed by arm, in the contract's arm order, chronological inside each
 * bucket. Ordering by anything derived from the numbers would be a ranking, so
 * the only orders available here are the declared one and the clock.
 */
function groupByArm(
  experiments: readonly Experiment[],
): { arm: ExperimentArm; experiments: Experiment[] }[] {
  return ARM_ORDER.map((arm) => ({
    arm,
    experiments: experiments
      .filter((experiment) => experiment.arm === arm)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
  }));
}

/**
 * Several rows rendered together.
 *
 * Grouped by arm because that is how the records were produced. No arm is
 * measured against another here: the set is a listing, and what a reader makes
 * of it is their judgement to make with the confounds in front of them.
 */
export function renderReportSet(experiments: readonly Experiment[]): ExperimentReportSet {
  return {
    arms: groupByArm(experiments).map((group) => ({
      arm: group.arm,
      reports: group.experiments.map(renderReport),
    })),
    confound_notice: EXPERIMENT_CONFOUND_NOTICE,
  };
}

/** The set as text. Every arm section is present, including the empty ones. */
export function renderReportSetText(experiments: readonly Experiment[]): string {
  const lines: string[] = [];
  for (const group of groupByArm(experiments)) {
    lines.push(`arm ${group.arm}: ${group.experiments.length} experiment(s)`);
    // Rendered through the single-row path, so a row inside a set and a row on
    // its own are the same text and neither can gain a field the other lacks.
    for (const experiment of group.experiments) lines.push(renderReportText(experiment));
  }
  lines.push(EXPERIMENT_CONFOUND_NOTICE);
  return lines.join("\n");
}
