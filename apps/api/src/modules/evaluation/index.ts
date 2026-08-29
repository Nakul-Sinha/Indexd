/**
 * The evaluation harness.
 *
 * This module turns "the agent suggests things" into "the agent's suggestions
 * moved metric X by Y, with these confounds". It produces `Experiment` rows and
 * renders them. It does not decide anything.
 *
 * ## What the numbers are, and what they are not
 *
 * Every deployment is versioned and every instrumented server produces rollups,
 * so a rule change has a window before it and a window after it. Subtracting one
 * from the other is a measurement, and a measured outcome is worth more than an
 * assertion. It is also an interrupted time series on one server, which is not a
 * controlled trial, and the following are uncontrolled in every `pre_post` row
 * this module writes:
 *
 *   - **Order effects.** The arms ran one after another. Anything that moved
 *     with time moved with the arm.
 *   - **Time of day.** The two windows sit at different clock times, and a group
 *     plays differently at 19:00 than at 23:00.
 *   - **Novelty.** A rule change is interesting because it is new, and that
 *     decays on its own with no help from the rule.
 *   - **Player memory.** Players remember the first arm. A snapshot restore
 *     resets the world and resets nothing about the people playing in it, and
 *     the second arm is played by people who already know how the first went.
 *   - **Sample size.** A friend group's worth of players and sessions.
 *
 * `parallel`, two servers with a split population, removes the order effect and
 * costs double the infrastructure. It is supported and it is recorded only when
 * a second server actually ran the counterpart. What is deliberately not
 * supported is two arms from one snapshot on one live server: returning to the
 * snapshot for the second arm discards everything played during the first, and
 * nobody accepts that twice.
 *
 * ## The output
 *
 * `delta`, `n_players`, `n_sessions`, and the confounds. There is no verdict
 * field on the row, no ranking in the rendering, and no function here that takes
 * two arms and returns a judgement about them. That is not a convention the
 * module keeps; it is the absence of any code that could do otherwise, which is
 * the only version of the rule that survives someone adding a feature in a
 * hurry. `EXPERIMENT_CONFOUND_NOTICE` is a required field of every rendered
 * report for the same reason.
 *
 * A directional result with its confounds named, including the ones that point
 * the wrong way, is worth more than a clean claim nobody believes.
 *
 * ## Shape
 *
 * | File | Responsibility |
 * |---|---|
 * | `harness.ts` | One completed deployment in, one experiment row out. |
 * | `windows.ts` | Selecting the before and after windows around a cutover. |
 * | `metrics.ts` | Merging rollups and subtracting one side from the other. |
 * | `sampler.ts` | The random-valid-rule baseline arm's document source. |
 * | `confounds.ts` | The closed set of notes a row may carry. |
 * | `report.ts` | Rendering, with the confound notice attached. |
 * | `store.ts` | `ExperimentStore` plus the in-memory implementation. |
 */

export {
  CONFOUND_NOTES,
  CONFOUND_TAGS,
  type ConfoundTag,
  DESIGN_CONFOUNDS,
  MAX_NOTES_LENGTH,
  renderNotes,
} from "./confounds.ts";
export {
  deriveDesign,
  EvaluationHarness,
  type HarnessOptions,
  isEvaluable,
  type ParallelRun,
  type RecordInput,
  type RecordOutcome,
  SameServerParallelError,
  type SkipReason,
} from "./harness.ts";
export {
  type CounterKey,
  countSample,
  type MergedWindow,
  mergeRollups,
  metricDelta,
} from "./metrics.ts";
export {
  ARM_ORDER,
  type ArmSection,
  type ExperimentReport,
  type ExperimentReportSet,
  REPORT_KEYS,
  renderReport,
  renderReportSet,
  renderReportSetText,
  renderReportText,
} from "./report.ts";
export {
  DEFAULT_MAX_ATTEMPTS,
  type RandomRuleSample,
  type Rng,
  SamplerExhaustedError,
  type SamplerOptions,
  sampleRandomRuleDocument,
  sampleRandomRuleDocuments,
  seededRng,
} from "./sampler.ts";
export {
  DuplicateExperimentError,
  type ExperimentStore,
  InMemoryExperimentStore,
} from "./store.ts";
export {
  DEFAULT_SPAN_MS,
  selectWindows,
  type WindowSelection,
  type WindowSelectionOptions,
  type WindowSelectionResult,
} from "./windows.ts";
