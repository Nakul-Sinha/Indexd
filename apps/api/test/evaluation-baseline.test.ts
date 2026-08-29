import { describe, expect, test } from "bun:test";
import { provisionalValidation, provisionalVocabulary } from "@farlands/contracts";
import {
  EvaluationHarness,
  InMemoryExperimentStore,
  renderReport,
  renderReportText,
  SamplerExhaustedError,
  sampleRandomRuleDocument,
  sampleRandomRuleDocuments,
  seededRng,
} from "../src/modules/evaluation/index.ts";
import { completedDeployment, fixtureRollups, SERVER_CONTEXT } from "./evaluation-support.ts";

/**
 * The random-valid-rule baseline arm.
 *
 * Two things are being asserted here, and the second is the one that matters.
 * First, that the sampler's documents are valid, through the same validator the
 * authoring pipeline calls, with no path around it. Second, that a baseline run
 * is recorded and rendered by exactly the code a Director run is: if the arms
 * were measured differently, comparing them would be meaningless, and the
 * project's own falsification criterion would have nothing to rest on.
 */

const SAMPLE_SIZE = 200;

function sampleMany(seed: number, ruleCount = 3) {
  return sampleRandomRuleDocuments(SAMPLE_SIZE, SERVER_CONTEXT, {
    rng: seededRng(seed),
    ruleCount,
  });
}

describe("the sampler produces documents validation.ts accepts", () => {
  test("two hundred documents, re-validated independently, all pass", () => {
    for (const sample of sampleMany(20260829)) {
      // The same call the authoring pipeline makes, on the same context. A
      // document the sampler returned is checked again here rather than trusted.
      const recheck = provisionalValidation.validateRuleDocument(sample.document, SERVER_CONTEXT);
      expect(recheck.ok).toBe(true);
      // Zero rejections is the expected steady state: the sampler draws inside
      // the vocabulary rather than guessing and retrying.
      expect(sample.rejected).toBe(0);
    }
  });

  test("the sample covers every rule kind the vocabulary declares", () => {
    const seen = new Set<string>();
    for (const sample of sampleMany(7)) {
      for (const rule of sample.document.rules) seen.add(rule.rule);
    }
    // Coupled to the vocabulary on purpose: a primitive added to the action
    // space the Director may use has to be one the baseline arm can use too,
    // or the comparison is between different action spaces.
    expect([...seen].sort()).toEqual([...provisionalVocabulary.RULE_KINDS].sort());
  });

  test("regions come from the server's own list, never invented", () => {
    const allowed = new Set(SERVER_CONTEXT.regions);
    for (const sample of sampleMany(11)) {
      for (const rule of sample.document.rules) {
        if ("region" in rule && rule.region !== undefined)
          expect(allowed.has(rule.region)).toBe(true);
      }
    }
  });

  test("a server with no regions gets world-wide rules rather than a rejected document", () => {
    const context = { server_id: "srv_new", regions: [] };
    for (const sample of sampleRandomRuleDocuments(50, context, { rng: seededRng(3) })) {
      expect(provisionalValidation.validateRuleDocument(sample.document, context).ok).toBe(true);
      for (const rule of sample.document.rules) {
        expect("region" in rule && rule.region !== undefined).toBe(false);
      }
    }
  });

  test("no multiplier is zero, so no rule silently disables anything", () => {
    for (const sample of sampleMany(13)) {
      for (const rule of sample.document.rules) {
        if ("multiplier" in rule) expect(rule.multiplier).toBeGreaterThan(0);
      }
    }
  });

  test("the same seed replays the same documents", () => {
    const first = sampleRandomRuleDocument(SERVER_CONTEXT, { rng: seededRng(99) });
    const second = sampleRandomRuleDocument(SERVER_CONTEXT, { rng: seededRng(99) });
    // "Which documents did the baseline arm deploy" has to stay answerable from
    // the seed months after the servers are gone.
    expect(first.document).toEqual(second.document);

    const other = sampleRandomRuleDocument(SERVER_CONTEXT, { rng: seededRng(100) });
    expect(other.document).not.toEqual(first.document);
  });
});

describe("there is no path around validation.ts", () => {
  test("a document the validator cannot accept is raised, never returned", () => {
    // The vocabulary permits 1 to 64 rules. Asking for none produces candidates
    // that fail the shape pass on every attempt.
    expect(() =>
      sampleRandomRuleDocument(SERVER_CONTEXT, { rng: seededRng(1), ruleCount: 0 }),
    ).toThrow(SamplerExhaustedError);

    expect(() =>
      sampleRandomRuleDocument(SERVER_CONTEXT, { rng: seededRng(1), ruleCount: 65 }),
    ).toThrow(SamplerExhaustedError);
  });

  test("the failure names the validation errors, so it is diagnosable", () => {
    try {
      sampleRandomRuleDocument(SERVER_CONTEXT, { rng: seededRng(1), ruleCount: 0, maxAttempts: 3 });
      throw new Error("expected the sampler to give up");
    } catch (error) {
      expect(error).toBeInstanceOf(SamplerExhaustedError);
      if (!(error instanceof SamplerExhaustedError)) throw error;
      expect(error.attempts).toBe(3);
      expect(error.lastErrors.length).toBeGreaterThan(0);
      expect(error.message).toContain("rules");
    }
  });
});

describe("baseline runs are recorded and reported identically to Director runs", () => {
  async function twoArms() {
    const rollups = await fixtureRollups(300);
    const store = new InMemoryExperimentStore();
    const harness = new EvaluationHarness({
      store,
      newId: () => "exp_fixed",
      now: () => new Date("2026-08-30T09:00:00.000Z"),
      spanMs: 60 * 60 * 1000,
    });

    // Identical inputs bar the arm and the deployment the row hangs off.
    const director = await harness.record({
      deployment: completedDeployment({ deployment_id: "dep_dir" }),
      arm: "director",
      rollups,
    });
    const baseline = await harness.record({
      deployment: completedDeployment({ deployment_id: "dep_rnd" }),
      arm: "random_baseline",
      rollups,
    });
    if (!director.recorded || !baseline.recorded) throw new Error("expected two experiments");
    return { director: director.experiment, baseline: baseline.experiment, store };
  }

  test("the rows differ only in the arm and the deployment they name", async () => {
    const { director, baseline } = await twoArms();
    expect({ ...director, arm: baseline.arm, deployment_id: baseline.deployment_id }).toEqual(
      baseline,
    );
  });

  test("the windows, metrics, delta and n are the same measurement", async () => {
    const { director, baseline } = await twoArms();
    expect(baseline.window_before).toEqual(director.window_before);
    expect(baseline.window_after).toEqual(director.window_after);
    expect(baseline.metrics_before).toEqual(director.metrics_before);
    expect(baseline.metrics_after).toEqual(director.metrics_after);
    expect(baseline.delta).toEqual(director.delta);
    expect(baseline.n_players).toBe(director.n_players);
    expect(baseline.n_sessions).toBe(director.n_sessions);
    // Including the confounds: a baseline arm run pre/post is uncontrolled for
    // exactly what a Director arm run pre/post is uncontrolled for.
    expect(baseline.notes).toBe(director.notes);
    expect(baseline.design).toBe(director.design);
  });

  test("the rendered reports differ only where the rows do", async () => {
    const { director, baseline } = await twoArms();
    const rendered = renderReport(baseline);
    expect({
      ...renderReport(director),
      arm: rendered.arm,
      deployment_id: rendered.deployment_id,
    }).toEqual(rendered);

    const directorText = renderReportText(director)
      .replaceAll("director", "ARM")
      .replaceAll("dep_dir", "DEP");
    const baselineText = renderReportText(baseline)
      .replaceAll("random_baseline", "ARM")
      .replaceAll("dep_rnd", "DEP");
    expect(baselineText).toBe(directorText);
  });

  test("both arms are persisted the same way, in one store", async () => {
    const { store } = await twoArms();
    const rows = await store.list(SERVER_CONTEXT.server_id);
    expect(rows.map((row) => row.arm)).toEqual(["director", "random_baseline"]);
    // Same table, same shape, same fields populated. Nothing marks one of them
    // as the reference and the other as the thing being judged.
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(Object.keys(rows[1] ?? {}).sort());
  });
});
