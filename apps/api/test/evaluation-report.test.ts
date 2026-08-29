import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { EXPERIMENT_CONFOUND_NOTICE, type Experiment, ExperimentArm } from "@farlands/contracts";
import * as evaluation from "../src/modules/evaluation/index.ts";
import {
  ARM_ORDER,
  EvaluationHarness,
  InMemoryExperimentStore,
  REPORT_KEYS,
  renderReport,
  renderReportSet,
  renderReportSetText,
  renderReportText,
} from "../src/modules/evaluation/index.ts";
import { completedDeployment, fixtureRollups, MODULE_DIR } from "./evaluation-support.ts";

/**
 * The reporting rules, asserted structurally.
 *
 * "Report delta and n, never a winner" is only worth anything if it is a
 * property of the code rather than a habit of whoever wrote it. These tests read
 * the module's own source and its export surface, so a future path that emits a
 * verdict fails here even if nothing calls it yet.
 */

/**
 * The vocabulary of a claim this design cannot support.
 *
 * Matched case-insensitively against the module's source, comments included. A
 * word here is not banned because it is rude; it is banned because a friend
 * group's worth of sessions in an uncontrolled time series cannot support the
 * sentence it would appear in.
 */
const VERDICT_VOCABULARY = [
  "p_value",
  "p-value",
  "pvalue",
  "significant",
  "significance",
  "winner",
  "wins",
  "better",
  "best",
  "outperform",
  "hypothesis",
  "confidence_interval",
];

async function moduleSources(): Promise<{ name: string; text: string }[]> {
  const names = (await readdir(MODULE_DIR)).filter((name) => name.endsWith(".ts"));
  return Promise.all(
    names.map(async (name) => ({ name, text: await readFile(joinPath(MODULE_DIR, name), "utf8") })),
  );
}

async function anExperiment(overrides: Partial<Experiment> = {}): Promise<Experiment> {
  const rollups = await fixtureRollups(300);
  const store = new InMemoryExperimentStore();
  const harness = new EvaluationHarness({
    store,
    newId: () => "exp_1",
    now: () => new Date("2026-08-30T09:00:00.000Z"),
    spanMs: 60 * 60 * 1000,
  });
  const outcome = await harness.record({
    deployment: completedDeployment(),
    arm: "director",
    rollups,
  });
  if (!outcome.recorded) throw new Error("expected a recorded experiment");
  return { ...outcome.experiment, ...overrides };
}

describe("no code path emits a verdict", () => {
  test("the module's source does not contain the vocabulary of one", async () => {
    const sources = await moduleSources();
    // The scan is only meaningful if it read the module: seven files, and a
    // control token that must be there.
    expect(sources.length).toBeGreaterThanOrEqual(7);
    expect(sources.some((file) => file.text.includes("metricDelta"))).toBe(true);

    for (const file of sources) {
      const lowered = file.text.toLowerCase();
      for (const word of VERDICT_VOCABULARY) {
        expect(`${file.name}: ${lowered.includes(word)}`).toBe(`${file.name}: false`);
      }
    }
  });

  test("the export surface is exactly this, so a new one is a deliberate act", () => {
    // A function that ranked two arms would have to be added here to be
    // reachable, and adding it fails this test rather than passing review.
    expect(Object.keys(evaluation).sort()).toEqual([
      "ARM_ORDER",
      "CONFOUND_NOTES",
      "CONFOUND_TAGS",
      "DEFAULT_MAX_ATTEMPTS",
      "DEFAULT_SPAN_MS",
      "DESIGN_CONFOUNDS",
      "DuplicateExperimentError",
      "EvaluationHarness",
      "InMemoryExperimentStore",
      "MAX_NOTES_LENGTH",
      "REPORT_KEYS",
      "SameServerParallelError",
      "SamplerExhaustedError",
      "countSample",
      "deriveDesign",
      "isEvaluable",
      "mergeRollups",
      "metricDelta",
      "renderNotes",
      "renderReport",
      "renderReportSet",
      "renderReportSetText",
      "renderReportText",
      "sampleRandomRuleDocument",
      "sampleRandomRuleDocuments",
      "seededRng",
      "selectWindows",
    ]);
  });

  test("a rendered report has exactly the declared fields and no others", async () => {
    const report = renderReport(await anExperiment());
    expect(Object.keys(report).sort()).toEqual([...REPORT_KEYS].sort());
  });

  test("no field name in a report reads as a claim", async () => {
    const report = renderReport(await anExperiment());
    for (const key of Object.keys(report)) {
      for (const word of VERDICT_VOCABULARY) {
        expect(key.toLowerCase().includes(word)).toBe(false);
      }
    }
  });

  test("the rendered text carries direction and n, and states no claim", async () => {
    const text = renderReportText(await anExperiment());

    expect(text).toContain("n_players 7");
    expect(text).toContain("n_sessions 7");
    expect(text).toContain("blocks_broken: +3");
    expect(text).toContain("chat_messages: -5");

    // The notice is the one place the word "significance" appears anywhere near
    // this module, and it appears there to deny one.
    const withoutNotice = text.replace(EXPERIMENT_CONFOUND_NOTICE, "");
    for (const word of VERDICT_VOCABULARY) {
      expect(withoutNotice.toLowerCase().includes(word)).toBe(false);
    }
  });

  test("delta lines are alphabetical, so layout is not a ranking", async () => {
    const lines = renderReportText(await anExperiment()).split("\n");
    const from = lines.indexOf("  delta:");
    const to = lines.indexOf("  notes:");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);

    const listed = lines
      .slice(from + 1, to)
      .map((line) => line.trim().split(":")[0] ?? "")
      .filter((name) => name.length > 0);

    expect(listed).toEqual([...listed].sort());
    // Sorting by magnitude would have put leaves (+7) above blocks_broken (+3).
    expect(listed.indexOf("blocks_broken")).toBeLessThan(listed.indexOf("leaves"));
  });
});

describe("the confound notice travels with every report", () => {
  test("it is a required field, not a footer a caller may forget", async () => {
    const report = renderReport(await anExperiment());
    expect(report.confound_notice).toBe(EXPERIMENT_CONFOUND_NOTICE);
    // Taken from the contracts package by import, so no surface holds a copy
    // that could drift from the others or be edited down.
    expect(REPORT_KEYS).toContain("confound_notice");
  });

  test("every rendering surface carries it, for every arm", async () => {
    for (const arm of ARM_ORDER) {
      const experiment = await anExperiment({ arm });
      expect(renderReport(experiment).confound_notice).toBe(EXPERIMENT_CONFOUND_NOTICE);
      expect(renderReportText(experiment)).toContain(EXPERIMENT_CONFOUND_NOTICE);
      expect(renderReportSet([experiment]).confound_notice).toBe(EXPERIMENT_CONFOUND_NOTICE);
      expect(renderReportSetText([experiment])).toContain(EXPERIMENT_CONFOUND_NOTICE);
    }
  });

  test("an empty set still carries it", () => {
    expect(renderReportSet([]).confound_notice).toBe(EXPERIMENT_CONFOUND_NOTICE);
    expect(renderReportSetText([])).toContain(EXPERIMENT_CONFOUND_NOTICE);
  });
});

describe("arms are listed, never ranked", () => {
  test("the order is the contract's own, read rather than restated", () => {
    const declared = ExperimentArm.anyOf.map((member) => member.const);
    expect(ARM_ORDER).toEqual(declared);
    expect(ARM_ORDER).toEqual(["director", "human", "random_baseline"]);
  });

  test("report.ts names no arm, so it cannot branch on one", async () => {
    const sources = await moduleSources();
    const report = sources.find((file) => file.name === "report.ts");
    if (report === undefined) throw new Error("expected report.ts");

    for (const arm of ARM_ORDER) {
      expect(report.text.includes(`"${arm}"`)).toBe(false);
      expect(report.text.includes(`'${arm}'`)).toBe(false);
    }
  });

  test("every arm gets a section, including the ones with no runs", async () => {
    const set = renderReportSet([await anExperiment({ arm: "random_baseline" })]);
    expect(set.arms.map((section) => section.arm)).toEqual([...ARM_ORDER]);
    expect(set.arms.map((section) => section.reports.length)).toEqual([0, 0, 1]);
  });

  test("rows inside an arm are ordered by the clock, not by their numbers", async () => {
    const older = await anExperiment({
      experiment_id: "exp_older",
      created_at: "2026-08-30T09:00:00.000Z",
      delta: { deaths: 99 },
    });
    const newer = await anExperiment({
      experiment_id: "exp_newer",
      created_at: "2026-08-30T10:00:00.000Z",
      delta: { deaths: 1 },
    });

    const section = renderReportSet([newer, older]).arms.find(
      (candidate) => candidate.arm === "director",
    );
    if (section === undefined) throw new Error("expected a director section");
    expect(section.reports.map((report) => report.experiment_id)).toEqual([
      "exp_older",
      "exp_newer",
    ]);
  });
});

describe("the report is the row, with the notice attached", () => {
  test("nothing is computed at rendering time", async () => {
    const experiment = await anExperiment();
    const report = renderReport(experiment);

    // Every field except the notice is carried through unchanged. A number
    // that appeared only in a report would be a claim the record cannot back.
    const { confound_notice, ...carried } = report;
    expect(confound_notice).toBe(EXPERIMENT_CONFOUND_NOTICE);
    for (const [key, value] of Object.entries(carried)) {
      expect(value).toEqual(experiment[key as keyof Experiment]);
    }
  });
});
