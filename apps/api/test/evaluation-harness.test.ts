import { describe, expect, test } from "bun:test";
import { Experiment } from "@farlands/contracts";
import { getSchemaValidator } from "elysia";
import {
  CONFOUND_NOTES,
  DuplicateExperimentError,
  EvaluationHarness,
  InMemoryExperimentStore,
  isEvaluable,
  mergeRollups,
  metricDelta,
  SameServerParallelError,
  selectWindows,
} from "../src/modules/evaluation/index.ts";
import {
  CUTOVER,
  completedDeployment,
  fixtureRollups,
  SERVER,
  STRADDLING_CUTOVER,
} from "./evaluation-support.ts";

/**
 * The harness against the recorded telemetry fixture.
 *
 * The per-window numbers this file asserts against were computed from the same
 * fixture by test/telemetry-rollup.test.ts, which derives them from a
 * straight-line pass that shares no code with the aggregator. Summing them here
 * by hand and asserting the harness reproduces the sum is what makes this a
 * check on the harness rather than on itself.
 */

const experimentValidator = getSchemaValidator(Experiment, {});

function harness(store: InMemoryExperimentStore, sequence = { n: 0 }) {
  return new EvaluationHarness({
    store,
    newId: () => `exp_${++sequence.n}`,
    now: () => new Date("2026-08-30T09:00:00.000Z"),
    // The fixture is 45 minutes long, so an hour either side takes all of it.
    spanMs: 60 * 60 * 1000,
  });
}

describe("a completed deployment on an instrumented server yields a row", () => {
  test("both windows, both metric sets, delta, n_players and n_sessions", async () => {
    const rollups = await fixtureRollups(300);
    const store = new InMemoryExperimentStore();
    const outcome = await harness(store).record({
      deployment: completedDeployment(),
      arm: "director",
      rollups,
    });

    expect(outcome.recorded).toBe(true);
    if (!outcome.recorded) throw new Error("expected a recorded experiment");
    const row = outcome.experiment;

    // Five windows before the cutover, four after. The 18:25 window opens at
    // the cutover instant, so it is entirely on the after side.
    expect(row.window_before).toEqual({
      start: "2026-08-29T18:00:00.000Z",
      end: "2026-08-29T18:25:00.000Z",
    });
    expect(row.window_after).toEqual({
      start: "2026-08-29T18:25:00.000Z",
      end: "2026-08-29T18:45:00.000Z",
    });

    expect(row.metrics_before).toEqual({
      joins: 7,
      leaves: 0,
      deaths: 4,
      blocks_placed: 9,
      blocks_broken: 17,
      chat_messages: 5,
      unique_players: 7,
      mean_session_seconds: null,
      seconds_in_region: { mining_world: 343, spawn: 185, nether_hub: 120 },
    });

    expect(row.metrics_after).toEqual({
      joins: 0,
      leaves: 7,
      deaths: 4,
      blocks_placed: 9,
      blocks_broken: 20,
      chat_messages: 0,
      unique_players: 7,
      mean_session_seconds: 2193.48,
      seconds_in_region: { mining_world: 52 },
    });

    expect(row.delta).toEqual({
      joins: -7,
      leaves: 7,
      deaths: 0,
      blocks_placed: 0,
      blocks_broken: 3,
      chat_messages: -5,
      unique_players: 0,
      "seconds_in_region.mining_world": -291,
      "seconds_in_region.nether_hub": -120,
      "seconds_in_region.spawn": -185,
    });

    expect(row.n_players).toBe(7);
    expect(row.n_sessions).toBe(7);
    expect(row.server_id).toBe(SERVER);
    expect(row.deployment_id).toBe("dep_001");
    expect(row.rule_version).toBe(2);
  });

  test("a metric measurable on one side only is absent from delta, not zero", async () => {
    const rollups = await fixtureRollups(300);
    const store = new InMemoryExperimentStore();
    const outcome = await harness(store).record({
      deployment: completedDeployment(),
      arm: "director",
      rollups,
    });
    if (!outcome.recorded) throw new Error("expected a recorded experiment");

    // Every session in the fixture closes in the last window, so the before
    // side has no mean at all. Reporting a delta of zero would say the mean did
    // not move, which is a claim about data nobody has.
    expect(outcome.experiment.metrics_before.mean_session_seconds).toBeNull();
    expect(Object.keys(outcome.experiment.delta)).not.toContain("mean_session_seconds");
  });

  test("the row validates against the Experiment contract", async () => {
    const rollups = await fixtureRollups(300);
    const store = new InMemoryExperimentStore();
    const outcome = await harness(store).record({
      deployment: completedDeployment(),
      arm: "random_baseline",
      rollups,
    });
    if (!outcome.recorded) throw new Error("expected a recorded experiment");
    expect(experimentValidator.Check(outcome.experiment)).toBe(true);
  });

  test("every completed deployment yields one row, and it is persisted", async () => {
    const rollups = await fixtureRollups(300);
    const store = new InMemoryExperimentStore();
    const runner = harness(store);

    const deployments = [
      completedDeployment({ deployment_id: "dep_001", to_version: 2 }),
      completedDeployment({ deployment_id: "dep_002", to_version: 3 }),
      completedDeployment({ deployment_id: "dep_003", to_version: 4 }),
    ];

    for (const deployment of deployments) {
      const outcome = await runner.record({ deployment, arm: "director", rollups });
      expect(outcome.recorded).toBe(true);
      if (!outcome.recorded) continue;
      // The four reported quantities are present on every row, with no branch
      // that could leave one of them off.
      expect(typeof outcome.experiment.delta).toBe("object");
      expect(Number.isInteger(outcome.experiment.n_players)).toBe(true);
      expect(Number.isInteger(outcome.experiment.n_sessions)).toBe(true);
      expect(outcome.experiment.notes).not.toBeNull();
    }

    const rows = await store.list(SERVER);
    expect(rows.map((row) => row.deployment_id)).toEqual(["dep_001", "dep_002", "dep_003"]);
    expect(rows).toHaveLength(deployments.length);
  });
});

describe("deployments and servers that yield no row, and say why", () => {
  test("a deployment that aborted or failed is not evaluated", async () => {
    const rollups = await fixtureRollups(300);
    const store = new InMemoryExperimentStore();
    const runner = harness(store);

    for (const state of ["aborted", "failed", "cutover"] as const) {
      const outcome = await runner.record({
        deployment: completedDeployment({
          state,
          finished_at: state === "cutover" ? null : CUTOVER,
        }),
        arm: "director",
        rollups,
      });
      expect(outcome).toEqual({ recorded: false, reason: "deployment_not_complete" });
    }
    expect(store.contents()).toEqual({});
  });

  test("isEvaluable is idle plus a finish time, and nothing else", () => {
    expect(isEvaluable(completedDeployment())).toBe(true);
    expect(isEvaluable(completedDeployment({ state: "draining" }))).toBe(false);
    expect(isEvaluable(completedDeployment({ finished_at: null }))).toBe(false);
  });

  test("an uninstrumented server yields no row rather than a row of zeroes", async () => {
    const store = new InMemoryExperimentStore();
    const outcome = await harness(store).record({
      deployment: completedDeployment(),
      arm: "director",
      rollups: [],
    });
    // A row of zeroes would be indistinguishable from a quiet evening, and the
    // delta would be a measurement of nothing presented as a measurement.
    expect(outcome).toEqual({ recorded: false, reason: "no_telemetry_before" });
  });

  test("a server with play only before the change reports the missing side", async () => {
    const rollups = await fixtureRollups(300);
    const store = new InMemoryExperimentStore();
    const outcome = await harness(store).record({
      deployment: completedDeployment({ finished_at: "2026-08-29T19:00:00.000Z" }),
      arm: "director",
      rollups,
    });
    expect(outcome).toEqual({ recorded: false, reason: "no_telemetry_after" });
  });
});

describe("windows that span the cutover belong to neither side", () => {
  test("a straddling window is dropped and the drop is recorded as a confound", async () => {
    const rollups = await fixtureRollups(300);
    const selection = selectWindows(rollups, STRADDLING_CUTOVER, { spanMs: 60 * 60 * 1000 });
    expect(selection.ok).toBe(true);
    if (!selection.ok) throw new Error("expected a selection");

    expect(selection.straddling).toBe(1);
    // Four windows before instead of five: 18:20 to 18:25 held play under both
    // rule sets, so counting it either way would credit one to the other.
    expect(selection.before.windows).toBe(4);
    expect(selection.after.windows).toBe(4);
    expect(selection.before.end).toBe("2026-08-29T18:20:00.000Z");
    expect(selection.after.start).toBe("2026-08-29T18:25:00.000Z");

    const store = new InMemoryExperimentStore();
    const outcome = await harness(store).record({
      deployment: completedDeployment({ finished_at: STRADDLING_CUTOVER }),
      arm: "director",
      rollups,
    });
    if (!outcome.recorded) throw new Error("expected a recorded experiment");
    expect(outcome.experiment.notes).toContain(CONFOUND_NOTES.straddling_window_dropped);
  });

  test("a clean boundary drops nothing and does not claim it did", async () => {
    const rollups = await fixtureRollups(300);
    const selection = selectWindows(rollups, CUTOVER, { spanMs: 60 * 60 * 1000 });
    if (!selection.ok) throw new Error("expected a selection");
    expect(selection.straddling).toBe(0);

    const store = new InMemoryExperimentStore();
    const outcome = await harness(store).record({
      deployment: completedDeployment(),
      arm: "director",
      rollups,
    });
    if (!outcome.recorded) throw new Error("expected a recorded experiment");
    expect(outcome.experiment.notes).not.toContain(CONFOUND_NOTES.straddling_window_dropped);
  });

  test("the same span is used either side, so the delta is not reading the clock", async () => {
    const rollups = await fixtureRollups(300);
    const narrow = selectWindows(rollups, CUTOVER, { spanMs: 10 * 60 * 1000 });
    if (!narrow.ok) throw new Error("expected a selection");

    expect(narrow.before.windows).toBe(2);
    expect(narrow.after.windows).toBe(2);
    expect(narrow.before.start).toBe("2026-08-29T18:15:00.000Z");
    expect(narrow.after.end).toBe("2026-08-29T18:35:00.000Z");
  });
});

describe("merging several windows into one side", () => {
  test("unique_players is a lower bound, never a sum of per-window counts", async () => {
    const rollups = await fixtureRollups(300);
    const merged = mergeRollups(rollups);
    if (merged === null) throw new Error("expected a merged window");

    // Summing the nine per-window counts gives 51 for a fixture with seven
    // people in it. The set members are discarded by the rollup, so the largest
    // window is the most the merge can honestly claim.
    expect(merged.metrics.unique_players).toBe(7);
    expect(rollups.reduce((sum, row) => sum + row.metrics.unique_players, 0)).toBe(51);
  });

  test("counters add and per-region seconds add", async () => {
    const rollups = await fixtureRollups(300);
    const merged = mergeRollups(rollups);
    if (merged === null) throw new Error("expected a merged window");

    expect(merged.metrics.joins).toBe(7);
    expect(merged.metrics.leaves).toBe(7);
    expect(merged.metrics.deaths).toBe(8);
    expect(merged.metrics.blocks_placed).toBe(18);
    expect(merged.metrics.blocks_broken).toBe(37);
    expect(merged.metrics.chat_messages).toBe(5);
    expect(merged.metrics.seconds_in_region).toEqual({
      mining_world: 395,
      spawn: 185,
      nether_hub: 120,
    });
  });

  test("merging every window matches one long window from the aggregator", async () => {
    const merged = mergeRollups(await fixtureRollups(300));
    const single = (await fixtureRollups(3600))[0];
    if (merged === null || single === undefined) throw new Error("expected both");

    // Everything except the two fields that cannot be recovered from counters.
    const { unique_players: _a, mean_session_seconds: _b, ...mergedRest } = merged.metrics;
    const { unique_players: _c, mean_session_seconds: _d, ...singleRest } = single.metrics;
    expect(mergedRest).toEqual(singleRest);
  });

  test("a merged mean is null when no session closed on that side", async () => {
    const rollups = await fixtureRollups(300);
    const merged = mergeRollups(rollups.slice(0, 5));
    if (merged === null) throw new Error("expected a merged window");
    expect(merged.metrics.mean_session_seconds).toBeNull();
  });

  test("merging nothing is null rather than an empty window", () => {
    expect(mergeRollups([])).toBeNull();
  });
});

describe("delta is subtraction and nothing more", () => {
  test("after minus before, per metric, with regions kept apart", async () => {
    const rollups = await fixtureRollups(3600);
    const single = rollups[0];
    if (single === undefined) throw new Error("expected a rollup");

    const delta = metricDelta(single.metrics, single.metrics);
    // A window against itself is zero everywhere, including the regions.
    for (const value of Object.values(delta)) expect(value).toBe(0);
    expect(Object.keys(delta).sort()).toEqual([
      "blocks_broken",
      "blocks_placed",
      "chat_messages",
      "deaths",
      "joins",
      "leaves",
      "mean_session_seconds",
      "seconds_in_region.mining_world",
      "seconds_in_region.nether_hub",
      "seconds_in_region.spawn",
      "unique_players",
    ]);
  });

  test("a region present on one side only counts as zero seconds on the other", async () => {
    const rollups = await fixtureRollups(300);
    const before = rollups[2];
    const after = rollups[4];
    if (before === undefined || after === undefined) throw new Error("expected two rollups");

    const delta = metricDelta(before.metrics, after.metrics);
    // spawn had 120 seconds before and none after: no time recorded is zero
    // seconds, not a gap, because the window exists and simply saw nobody there.
    expect(delta["seconds_in_region.spawn"]).toBe(-120);
    expect(delta["seconds_in_region.nether_hub"]).toBe(120);
  });
});

describe("design is what ran, not what was wanted", () => {
  test("one server is pre_post", async () => {
    const rollups = await fixtureRollups(300);
    const store = new InMemoryExperimentStore();
    const outcome = await harness(store).record({
      deployment: completedDeployment(),
      arm: "director",
      rollups,
    });
    if (!outcome.recorded) throw new Error("expected a recorded experiment");
    expect(outcome.experiment.design).toBe("pre_post");
  });

  test("parallel is recorded only when a second server actually ran the counterpart", async () => {
    const rollups = await fixtureRollups(300);
    const store = new InMemoryExperimentStore();
    const outcome = await harness(store).record({
      deployment: completedDeployment(),
      arm: "director",
      rollups,
      parallel: { server_id: "srv_9k1", deployment_id: "dep_777" },
    });
    if (!outcome.recorded) throw new Error("expected a recorded experiment");
    expect(outcome.experiment.design).toBe("parallel");
  });

  test("naming the server as its own parallel peer raises", async () => {
    const rollups = await fixtureRollups(300);
    const store = new InMemoryExperimentStore();

    // The only way to get a second arm out of one server is a snapshot restore
    // between them, which discards the play the first arm produced. There is no
    // design value for that because the harness will not record it.
    await expect(
      harness(store).record({
        deployment: completedDeployment(),
        arm: "director",
        rollups,
        parallel: { server_id: SERVER, deployment_id: "dep_777" },
      }),
    ).rejects.toBeInstanceOf(SameServerParallelError);

    await expect(
      harness(store).record({
        deployment: completedDeployment(),
        arm: "director",
        rollups,
        parallel: { server_id: "srv_9k1", deployment_id: "dep_001" },
      }),
    ).rejects.toBeInstanceOf(SameServerParallelError);

    expect(store.contents()).toEqual({});
  });

  test("a caller cannot declare the design directly", async () => {
    const rollups = await fixtureRollups(300);
    const store = new InMemoryExperimentStore();

    // RecordInput has no design field, so this cast is the closest a caller can
    // get to asking for one. The row still records what happened.
    const wishful = {
      deployment: completedDeployment(),
      arm: "director",
      rollups,
      design: "parallel",
    } as unknown as Parameters<EvaluationHarness["record"]>[0];

    const outcome = await harness(store).record(wishful);
    if (!outcome.recorded) throw new Error("expected a recorded experiment");
    expect(outcome.experiment.design).toBe("pre_post");
  });

  test("the confounds attached follow the design that ran", async () => {
    const rollups = await fixtureRollups(300);
    const store = new InMemoryExperimentStore();
    const runner = harness(store);

    const prePost = await runner.record({
      deployment: completedDeployment({ deployment_id: "dep_010" }),
      arm: "director",
      rollups,
    });
    const parallel = await runner.record({
      deployment: completedDeployment({ deployment_id: "dep_011" }),
      arm: "director",
      rollups,
      parallel: { server_id: "srv_9k1", deployment_id: "dep_012" },
    });
    if (!prePost.recorded || !parallel.recorded) throw new Error("expected two experiments");

    // Order effects and player memory are what a split population removes, and
    // they are the two the parallel row stops carrying.
    expect(prePost.experiment.notes).toContain(CONFOUND_NOTES.order_effects);
    expect(prePost.experiment.notes).toContain(CONFOUND_NOTES.player_memory);
    expect(parallel.experiment.notes).not.toContain(CONFOUND_NOTES.order_effects);
    expect(parallel.experiment.notes).not.toContain(CONFOUND_NOTES.player_memory);

    // The sample is still a friend group either way, and it still says so.
    expect(prePost.experiment.notes).toContain(CONFOUND_NOTES.friend_group_sample);
    expect(parallel.experiment.notes).toContain(CONFOUND_NOTES.friend_group_sample);
  });
});

describe("notes are a closed set, so no verdict can be written into one", () => {
  test("every line of a row's notes is one of the declared confounds", async () => {
    const rollups = await fixtureRollups(300);
    const store = new InMemoryExperimentStore();
    const outcome = await harness(store).record({
      deployment: completedDeployment(),
      arm: "director",
      rollups,
      confounds: ["counts_are_lower_bounds"],
    });
    if (!outcome.recorded) throw new Error("expected a recorded experiment");

    const declared = new Set<string>(Object.values(CONFOUND_NOTES));
    const lines = (outcome.experiment.notes ?? "").split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(declared.has(line)).toBe(true);
  });

  test("the sample-size caveat is on every row without a caller asking for it", async () => {
    const rollups = await fixtureRollups(300);
    const store = new InMemoryExperimentStore();
    const outcome = await harness(store).record({
      deployment: completedDeployment(),
      arm: "human",
      rollups,
    });
    if (!outcome.recorded) throw new Error("expected a recorded experiment");
    expect(outcome.experiment.notes).toContain(CONFOUND_NOTES.counts_are_lower_bounds);
    expect(outcome.experiment.notes).toContain(CONFOUND_NOTES.friend_group_sample);
  });
});

describe("the store matches what migration 0007 will enforce", () => {
  test("one row per deployment and arm", async () => {
    const rollups = await fixtureRollups(300);
    const store = new InMemoryExperimentStore();
    const runner = harness(store);

    await runner.record({ deployment: completedDeployment(), arm: "director", rollups });
    // The unique index is (deployment_id, arm). A second arm on the same
    // deployment is allowed; a second row for the same arm is not.
    await runner.record({ deployment: completedDeployment(), arm: "human", rollups });
    await expect(
      runner.record({ deployment: completedDeployment(), arm: "director", rollups }),
    ).rejects.toBeInstanceOf(DuplicateExperimentError);

    expect(await store.list(SERVER)).toHaveLength(2);
  });
});
