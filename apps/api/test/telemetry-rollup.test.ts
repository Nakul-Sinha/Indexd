import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { WorldEventsRollup } from "@farlands/contracts";
import { getSchemaValidator } from "elysia";
import {
  InMemoryRollupStore,
  parseNdjsonBatch,
  TelemetryAggregator,
  telemetryPlugin,
} from "../src/modules/telemetry/index.ts";

/**
 * The recorded fixture, replayed, with the numbers written out.
 *
 * The literals below were computed by a separate straight-line pass over the
 * NDJSON that shares no code with the aggregator, then committed. The fixture is
 * seeded and deterministic, so an exact assertion is available and a tolerance
 * would only hide a regression. If the fixture is regenerated, these numbers are
 * expected to change and the diff is the point.
 */

const fixturePath = joinPath(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
  "telemetry",
  "session-01.ndjson",
);

const SERVER = "srv_7f2";
const rollupValidator = getSchemaValidator(WorldEventsRollup, {});

async function fixtureText(): Promise<string> {
  return readFile(fixturePath, "utf8");
}

/** Replay through the HTTP surface, in batches, exactly as the emitter would. */
async function replayOverHttp(text: string, windowSeconds: number, batchSize = 25) {
  const store = new InMemoryRollupStore();
  const aggregator = new TelemetryAggregator({ store, windowSeconds });
  const app = telemetryPlugin({ store, aggregator });

  const lines = text.trim().split("\n");
  for (let i = 0; i < lines.length; i += batchSize) {
    const body = `${lines.slice(i, i + batchSize).join("\n")}\n`;
    const response = await app.handle(
      new Request(`http://localhost/internal/telemetry/${SERVER}`, {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body,
      }),
    );
    expect(response.status).toBe(200);
  }

  await aggregator.flush();
  return { store, aggregator, rows: await store.list(SERVER) };
}

describe("the fixture is what the tests below assume", () => {
  test("85 events, every one of them valid against the contract", async () => {
    const batch = parseNdjsonBatch(await fixtureText());
    expect(batch.events).toHaveLength(85);
    expect(batch.rejections).toHaveLength(0);
    expect(batch.oversized).toBe(false);
  });
});

describe("replaying session-01 into one window", () => {
  test("produces one rollup row with exactly these numbers", async () => {
    // An hour window holds the whole 45 minute session, so every session opens
    // and closes inside it and every metric is computable.
    const { rows } = await replayOverHttp(await fixtureText(), 3600);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error("expected one rollup row");

    expect(row.server_id).toBe(SERVER);
    expect(row.window_start).toBe("2026-08-29T18:00:00.000Z");
    expect(row.window_end).toBe("2026-08-29T19:00:00.000Z");

    expect(row.metrics.joins).toBe(7);
    expect(row.metrics.leaves).toBe(7);
    expect(row.metrics.deaths).toBe(8);
    expect(row.metrics.blocks_placed).toBe(18);
    expect(row.metrics.blocks_broken).toBe(37);
    expect(row.metrics.chat_messages).toBe(5);
    expect(row.metrics.unique_players).toBe(7);
    expect(row.metrics.seconds_in_region).toEqual({
      mining_world: 395,
      spawn: 185,
      nether_hub: 120,
    });

    // Seven sessions, summing to 15354.36 seconds.
    expect(row.metrics.mean_session_seconds).toBeCloseTo(2193.48, 9);
  });

  test("the row matches the WorldEventsRollup contract exactly", async () => {
    const { rows } = await replayOverHttp(await fixtureText(), 3600);
    for (const row of rows) {
      expect(rollupValidator.Check(row)).toBe(true);
    }
  });

  test("event counts add up to the 85 events the fixture holds", async () => {
    const { rows } = await replayOverHttp(await fixtureText(), 3600);
    const m = rows[0]?.metrics;
    if (m === undefined) throw new Error("expected one rollup row");

    // chat_messages sums a message count rather than counting events, and
    // seconds_in_region sums seconds, so both are excluded from this identity.
    const counted = m.joins + m.leaves + m.deaths + m.blocks_placed + m.blocks_broken;
    expect(counted).toBe(85 - 2 - 6);
  });
});

/** Named so the per-window literals below keep one shape rather than nine. */
interface WindowExpectation {
  joins: number;
  leaves: number;
  deaths: number;
  placed: number;
  broken: number;
  chat: number;
  players: number;
  regions: Record<string, number>;
}

describe("replaying session-01 into five minute windows", () => {
  test("produces nine rows with exactly these numbers", async () => {
    const { rows } = await replayOverHttp(await fixtureText(), 300);

    expect(rows.map((row) => row.window_start)).toEqual([
      "2026-08-29T18:00:00.000Z",
      "2026-08-29T18:05:00.000Z",
      "2026-08-29T18:10:00.000Z",
      "2026-08-29T18:15:00.000Z",
      "2026-08-29T18:20:00.000Z",
      "2026-08-29T18:25:00.000Z",
      "2026-08-29T18:30:00.000Z",
      "2026-08-29T18:35:00.000Z",
      "2026-08-29T18:40:00.000Z",
    ]);

    const expected: WindowExpectation[] = [
      { joins: 1, leaves: 0, deaths: 0, placed: 1, broken: 0, chat: 0, players: 1, regions: {} },
      {
        joins: 6,
        leaves: 0,
        deaths: 1,
        placed: 1,
        broken: 3,
        chat: 0,
        players: 6,
        regions: { mining_world: 203 },
      },
      {
        joins: 0,
        leaves: 0,
        deaths: 0,
        placed: 4,
        broken: 4,
        chat: 3,
        players: 7,
        regions: { spawn: 120 },
      },
      {
        joins: 0,
        leaves: 0,
        deaths: 2,
        placed: 1,
        broken: 5,
        chat: 0,
        players: 6,
        regions: { mining_world: 140, spawn: 65 },
      },
      {
        joins: 0,
        leaves: 0,
        deaths: 1,
        placed: 2,
        broken: 5,
        chat: 2,
        players: 7,
        regions: { nether_hub: 120 },
      },
      { joins: 0, leaves: 0, deaths: 1, placed: 4, broken: 5, chat: 0, players: 7, regions: {} },
      { joins: 0, leaves: 0, deaths: 1, placed: 3, broken: 6, chat: 0, players: 5, regions: {} },
      {
        joins: 0,
        leaves: 0,
        deaths: 0,
        placed: 2,
        broken: 7,
        chat: 0,
        players: 5,
        regions: { mining_world: 52 },
      },
      { joins: 0, leaves: 7, deaths: 2, placed: 0, broken: 2, chat: 0, players: 7, regions: {} },
    ];

    expect(rows).toHaveLength(expected.length);
    rows.forEach((row, index) => {
      const want = expected[index];
      if (want === undefined) throw new Error(`no expectation for row ${index}`);
      expect({
        joins: row.metrics.joins,
        leaves: row.metrics.leaves,
        deaths: row.metrics.deaths,
        placed: row.metrics.blocks_placed,
        broken: row.metrics.blocks_broken,
        chat: row.metrics.chat_messages,
        players: row.metrics.unique_players,
        regions: row.metrics.seconds_in_region,
      }).toEqual(want);
    });
  });

  test("counts summed across windows equal the single-window totals", async () => {
    const { rows } = await replayOverHttp(await fixtureText(), 300);
    const total = (pick: (m: (typeof rows)[number]["metrics"]) => number) =>
      rows.reduce((sum, row) => sum + pick(row.metrics), 0);

    expect(total((m) => m.joins)).toBe(7);
    expect(total((m) => m.leaves)).toBe(7);
    expect(total((m) => m.deaths)).toBe(8);
    expect(total((m) => m.blocks_placed)).toBe(18);
    expect(total((m) => m.blocks_broken)).toBe(37);
    expect(total((m) => m.chat_messages)).toBe(5);
  });

  test("unique_players is per window and is never summed into a total", async () => {
    const { rows } = await replayOverHttp(await fixtureText(), 300);
    const summed = rows.reduce((sum, row) => sum + row.metrics.unique_players, 0);
    // 51 across nine windows against 7 actual people. The number is only
    // meaningful inside its own window, which is why the rollup carries a
    // per-window count and no total.
    expect(summed).toBe(51);
    expect(Math.max(...rows.map((row) => row.metrics.unique_players))).toBe(7);
  });
});

describe("sessions that cross a window boundary", () => {
  test("a session open at the boundary is carried forward, not truncated", async () => {
    const { rows } = await replayOverHttp(await fixtureText(), 300);

    // Every join is in the first two windows and every leave is in the last, so
    // every session in this fixture crosses seven boundaries.
    const closing = rows.at(-1);
    if (closing === undefined) throw new Error("expected a closing window");

    // The window in which the sessions closed carries the full durations,
    // measured from the original joins some 36 minutes earlier.
    expect(closing.metrics.mean_session_seconds).toBeCloseTo(2193.48, 9);
    // Truncating at the boundary would have reported roughly the length of one
    // window instead, which is a property of the clock and not of the players.
    expect(closing.metrics.mean_session_seconds).toBeGreaterThan(300);

    // Every earlier window had sessions open across it and reports nothing.
    for (const row of rows.slice(0, -1)) {
      expect(row.metrics.mean_session_seconds).toBeNull();
    }
  });

  test("mean_session_seconds is null, never zero, when no session closed", async () => {
    const store = new InMemoryRollupStore();
    const aggregator = new TelemetryAggregator({ store, windowSeconds: 60 });

    aggregator.ingest(SERVER, [
      {
        kind: "join",
        ts: "2026-08-29T18:00:00.000Z",
        player_name: "mossgrove",
        region: null,
        subject: null,
        value: 1,
      },
      {
        kind: "block_broken",
        ts: "2026-08-29T18:01:00.000Z",
        player_name: "mossgrove",
        region: "spawn",
        subject: "stone",
        value: 1,
      },
    ]);
    await aggregator.flush();

    const rows = await store.list(SERVER);
    expect(rows).toHaveLength(2);
    // Null means not measurable. Zero would mean the sessions were
    // instantaneous, and a reader cannot tell those apart from a number alone.
    expect(rows[0]?.metrics.mean_session_seconds).toBeNull();
    expect(rows[0]?.metrics.joins).toBe(1);
  });

  test("a leave with no join counts as a leave and contributes no duration", async () => {
    const store = new InMemoryRollupStore();
    const aggregator = new TelemetryAggregator({ store, windowSeconds: 3600 });

    // A player who was already online when ingest started. There is no join to
    // pair with, and inventing one would manufacture a short session.
    aggregator.ingest(SERVER, [
      {
        kind: "leave",
        ts: "2026-08-29T18:30:00.000Z",
        player_name: "harrow_bell",
        region: null,
        subject: null,
        value: 1,
      },
    ]);
    await aggregator.flush();

    const row = (await store.list(SERVER))[0];
    expect(row?.metrics.leaves).toBe(1);
    expect(row?.metrics.unique_players).toBe(1);
    expect(row?.metrics.mean_session_seconds).toBeNull();
  });

  test("an unpaired leave does not drag down a mean that has real sessions in it", async () => {
    const store = new InMemoryRollupStore();
    const aggregator = new TelemetryAggregator({ store, windowSeconds: 3600 });

    aggregator.ingest(SERVER, [
      {
        kind: "join",
        ts: "2026-08-29T18:00:00.000Z",
        player_name: "mossgrove",
        region: null,
        subject: null,
        value: 1,
      },
      {
        kind: "leave",
        ts: "2026-08-29T18:10:00.000Z",
        player_name: "mossgrove",
        region: null,
        subject: null,
        value: 1,
      },
      {
        kind: "leave",
        ts: "2026-08-29T18:11:00.000Z",
        player_name: "harrow_bell",
        region: null,
        subject: null,
        value: 1,
      },
    ]);
    await aggregator.flush();

    const row = (await store.list(SERVER))[0];
    expect(row?.metrics.leaves).toBe(2);
    // One real session of 600 seconds. Counting the unpaired leave as a zero
    // length session would have halved this to 300.
    expect(row?.metrics.mean_session_seconds).toBe(600);
  });

  test("a second join with no leave in between takes the later start", async () => {
    const store = new InMemoryRollupStore();
    const aggregator = new TelemetryAggregator({ store, windowSeconds: 3600 });

    // The leave for the first session was lost in transit. Of the two available
    // guesses, the later join is the one that does not inflate the metric.
    aggregator.ingest(SERVER, [
      {
        kind: "join",
        ts: "2026-08-29T18:00:00.000Z",
        player_name: "quietfen",
        region: null,
        subject: null,
        value: 1,
      },
      {
        kind: "join",
        ts: "2026-08-29T18:20:00.000Z",
        player_name: "quietfen",
        region: null,
        subject: null,
        value: 1,
      },
      {
        kind: "leave",
        ts: "2026-08-29T18:30:00.000Z",
        player_name: "quietfen",
        region: null,
        subject: null,
        value: 1,
      },
    ]);
    await aggregator.flush();

    const row = (await store.list(SERVER))[0];
    expect(row?.metrics.mean_session_seconds).toBe(600);
    expect(row?.metrics.joins).toBe(2);
  });

  test("an open session too old to be real is pruned rather than held forever", async () => {
    const store = new InMemoryRollupStore();
    const aggregator = new TelemetryAggregator({
      store,
      windowSeconds: 3600,
      maxSessionSeconds: 60,
    });

    aggregator.ingest(SERVER, [
      {
        kind: "join",
        ts: "2026-08-29T18:00:00.000Z",
        player_name: "tinbucket",
        region: null,
        subject: null,
        value: 1,
      },
    ]);
    expect(aggregator.liveState()[SERVER]?.openSessions).toBe(1);

    // A window later, the join is older than any plausible session, so the
    // ledger drops it instead of growing without bound.
    aggregator.ingest(SERVER, [
      {
        kind: "join",
        ts: "2026-08-29T20:00:00.000Z",
        player_name: "mossgrove",
        region: null,
        subject: null,
        value: 1,
      },
    ]);
    await aggregator.flush();

    expect(aggregator.liveState()[SERVER]?.openSessions).toBe(0);
  });
});

describe("no raw events are persisted anywhere", () => {
  test("the store holds nine rollups and nothing else after 85 events", async () => {
    const { store } = await replayOverHttp(await fixtureText(), 300);
    const contents = store.contents();

    expect(Object.keys(contents)).toEqual([SERVER]);
    expect(contents[SERVER]).toHaveLength(9);

    // Inspected, not trusted: every object the store holds is checked against
    // WorldEventsRollup, and the contract's schema rejects extra properties, so
    // a row carrying a smuggled events array would fail here.
    for (const row of contents[SERVER] ?? []) {
      expect(rollupValidator.Check(row)).toBe(true);
    }
  });

  test("nothing event-shaped survives anywhere in the store", async () => {
    const text = await fixtureText();
    const { store } = await replayOverHttp(text, 300);
    const dump = JSON.stringify(store.contents());

    // Fields that exist on WorldEvent and on nothing in a rollup.
    for (const field of ['"kind"', '"subject"', '"player_name"', '"ts"']) {
      expect(dump).not.toContain(field);
    }
    // No event kind literal, and no block or entity identifier.
    for (const literal of ["block_broken", "chat_volume", "diamond_ore", "creeper"]) {
      expect(dump).not.toContain(literal);
    }
    // No player name at all, hostile or ordinary. unique_players is a count.
    for (const name of ["mossgrove", "tinbucket", "harrow_bell", "quietfen"]) {
      expect(dump).not.toContain(name);
    }
  });

  test("live memory holds one open window and one ledger entry per online player", async () => {
    const store = new InMemoryRollupStore();
    const aggregator = new TelemetryAggregator({ store, windowSeconds: 3600 });
    const batch = parseNdjsonBatch(await fixtureText());

    aggregator.ingest(SERVER, batch.events);
    // Mid-replay: one open window, and every session already closed, so the
    // ledger is empty. Nothing scales with the 85 events just ingested.
    expect(aggregator.liveState()).toEqual({ [SERVER]: { hasOpenWindow: true, openSessions: 0 } });
  });

  test("twenty thousand events cost the same storage as eighty-five", async () => {
    const small = new InMemoryRollupStore();
    const large = new InMemoryRollupStore();
    const smallAgg = new TelemetryAggregator({ store: small, windowSeconds: 3600 });
    const largeAgg = new TelemetryAggregator({ store: large, windowSeconds: 3600 });

    const event = (i: number) => ({
      kind: "block_broken" as const,
      // Every event inside one window, so the row count cannot explain the result.
      ts: new Date(Date.parse("2026-08-29T18:00:00.000Z") + (i % 1000)).toISOString(),
      player_name: `player_${i % 7}`,
      region: "spawn",
      subject: "stone",
      value: 1,
    });

    smallAgg.ingest(
      SERVER,
      Array.from({ length: 85 }, (_, i) => event(i)),
    );
    largeAgg.ingest(
      SERVER,
      Array.from({ length: 20_000 }, (_, i) => event(i)),
    );
    await Promise.all([smallAgg.flush(), largeAgg.flush()]);

    const smallDump = JSON.stringify(small.contents());
    const largeDump = JSON.stringify(large.contents());

    expect((small.contents()[SERVER] ?? []).length).toBe(1);
    expect((large.contents()[SERVER] ?? []).length).toBe(1);
    // The rollups differ only in the counters, so the serialized size differs
    // by the width of two integers rather than by 235 times.
    expect(largeDump.length - smallDump.length).toBeLessThan(10);
    expect(large.contents()[SERVER]?.[0]?.metrics.blocks_broken).toBe(20_000);
  });
});

describe("events that arrive after their window closed", () => {
  test("are dropped and counted rather than reopening a closed window", async () => {
    const store = new InMemoryRollupStore();
    const aggregator = new TelemetryAggregator({ store, windowSeconds: 60 });

    const late = {
      kind: "death" as const,
      ts: "2026-08-29T18:00:30.000Z",
      player_name: "mossgrove",
      region: "spawn",
      subject: "lava",
      value: 1,
    };

    aggregator.ingest(SERVER, [
      { ...late, ts: "2026-08-29T18:00:10.000Z" },
      { ...late, ts: "2026-08-29T18:01:10.000Z" },
    ]);
    const outcome = aggregator.ingest(SERVER, [late]);
    await aggregator.flush();

    expect(outcome.late).toBe(1);
    expect(aggregator.lateDropped).toBe(1);

    const rows = await store.list(SERVER);
    // Two windows, not three, and no duplicate row for the first window.
    expect(rows.map((row) => row.window_start)).toEqual([
      "2026-08-29T18:00:00.000Z",
      "2026-08-29T18:01:00.000Z",
    ]);
    expect(rows[0]?.metrics.deaths).toBe(1);
  });

  test("a late event after a flush does not create a second row for that window", async () => {
    const store = new InMemoryRollupStore();
    const aggregator = new TelemetryAggregator({ store, windowSeconds: 60 });

    const event = {
      kind: "death" as const,
      ts: "2026-08-29T18:00:10.000Z",
      player_name: "mossgrove",
      region: "spawn",
      subject: "lava",
      value: 1,
    };

    aggregator.ingest(SERVER, [event]);
    await aggregator.flush();
    const outcome = aggregator.ingest(SERVER, [event]);
    await aggregator.flush();

    expect(outcome.late).toBe(1);
    expect(await store.list(SERVER)).toHaveLength(1);
  });
});

describe("windows are aligned to absolute time", () => {
  test("boundaries do not depend on which batch arrived first", async () => {
    const text = await fixtureText();
    // The same events, cut into batches of different sizes. If boundaries were
    // set by the first event seen, the before/after windows the evaluation
    // harness compares would not be comparable across restarts.
    const a = await replayOverHttp(text, 300, 5);
    const b = await replayOverHttp(text, 300, 85);

    expect(a.rows.map((row) => row.window_start)).toEqual(b.rows.map((row) => row.window_start));
    expect(a.rows.map((row) => row.metrics)).toEqual(b.rows.map((row) => row.metrics));
  });
});
