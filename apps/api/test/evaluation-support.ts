import { readFile } from "node:fs/promises";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import type { Deployment, WorldEventsRollup } from "@farlands/contracts";
import {
  InMemoryRollupStore,
  parseNdjsonBatch,
  TelemetryAggregator,
} from "../src/modules/telemetry/index.ts";

/**
 * Shared setup for the evaluation tests.
 *
 * The before and after metrics come from replaying the recorded telemetry
 * fixture through the real aggregator rather than from numbers written by hand.
 * Hand-written metrics would let the harness agree with an arithmetic mistake,
 * and the point of the fixture is that both sides of a delta are produced by the
 * same code that produces them in the running system.
 */

export const SERVER = "srv_7f2";

/**
 * A cutover on a window boundary, so no window spans it and the split is the
 * clean case. The straddling case gets its own timestamp below.
 */
export const CUTOVER = "2026-08-29T18:25:00.000Z";

/** Mid-window, so the 18:20 window holds play under both rule sets. */
export const STRADDLING_CUTOVER = "2026-08-29T18:22:30.000Z";

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_PATH = joinPath(
  here,
  "..",
  "..",
  "..",
  "fixtures",
  "telemetry",
  "session-01.ndjson",
);

export const MODULE_DIR = joinPath(here, "..", "src", "modules", "evaluation");

/** The regions the fixture server actually has, from fixtures/rules/context.json. */
export const SERVER_CONTEXT = {
  server_id: SERVER,
  regions: ["spawn", "nether_hub", "mining_world"],
};

/** Replay the recorded session into rollups of the given window length. */
export async function fixtureRollups(windowSeconds: number): Promise<WorldEventsRollup[]> {
  const text = await readFile(FIXTURE_PATH, "utf8");
  const batch = parseNdjsonBatch(text);
  if (batch.rejections.length > 0) throw new Error("the telemetry fixture no longer parses");

  const store = new InMemoryRollupStore();
  const aggregator = new TelemetryAggregator({ store, windowSeconds });
  aggregator.ingest(SERVER, batch.events);
  await aggregator.flush();

  return [...(await store.list(SERVER))];
}

export interface DeploymentOverrides {
  deployment_id?: string;
  server_id?: string;
  state?: Deployment["state"];
  finished_at?: string | null;
  to_version?: number;
}

/** A deployment that completed, which is the only kind the harness evaluates. */
export function completedDeployment(overrides: DeploymentOverrides = {}): Deployment {
  return {
    deployment_id: overrides.deployment_id ?? "dep_001",
    server_id: overrides.server_id ?? SERVER,
    from_version: 1,
    to_version: overrides.to_version ?? 2,
    state: overrides.state ?? "idle",
    candidate_pod: null,
    snapshot_id: "snap_001",
    player_visible_ms: 4200,
    queue_position: null,
    approved_by: "owner",
    initiated_by: "owner",
    started_at: "2026-08-29T18:20:00.000Z",
    finished_at: overrides.finished_at === undefined ? CUTOVER : overrides.finished_at,
    error: null,
  };
}
