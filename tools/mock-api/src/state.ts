import {
  contentDigest,
  type Deployment,
  type DeploymentState,
  EMPTY_ROLLUP_METRICS,
  type RollupMetrics,
  type ServerSummary,
  type SseEvent,
} from "@farlands/contracts";

/**
 * In-memory state for the mock. Nothing here is durable and nothing here is a
 * design proposal for the real API: this exists so four clients have something
 * contract-shaped to develop against before the real controller is real.
 */

export interface ApprovalRecord {
  token: string;
  server_id: string;
  rule_set_version: number;
  content_digest: string;
  issued_to: string;
  expires_at: number;
  consumed_at: number | null;
}

export interface RuleVersionRecord {
  version: number;
  document: unknown;
  content_digest: string;
  source: "form" | "agent" | "director";
  source_prompt: string | null;
  created_at: string;
}

export const servers = new Map<string, ServerSummary>();
export const ruleVersions = new Map<string, RuleVersionRecord[]>();
export const deployments = new Map<string, Deployment>();
export const approvals = new Map<string, ApprovalRecord>();
export const telemetryReceived = new Map<string, number>();
export const rollups = new Map<string, RollupMetrics>();

/**
 * The SSE ring buffer, per server.
 *
 * The real implementation falls back to reconstructing from the database when a
 * client asks for an id older than the ring. The mock keeps a generous ring and
 * says so, rather than pretending to have a durable path it does not have.
 */
const RING_SIZE = 500;
const rings = new Map<string, SseEvent[]>();
const subscribers = new Map<string, Set<(event: SseEvent) => void>>();
let sequence = 0;

export function nextEventId(): string {
  sequence += 1;
  return String(sequence).padStart(12, "0");
}

export function publish(event: SseEvent): void {
  const ring = rings.get(event.server_id) ?? [];
  ring.push(event);
  if (ring.length > RING_SIZE) ring.shift();
  rings.set(event.server_id, ring);

  for (const listener of subscribers.get(event.server_id) ?? []) {
    listener(event);
  }
}

/** Events after the given Last-Event-ID, for replay on reconnect. */
export function replay(serverId: string, lastEventId: string | null): SseEvent[] {
  const ring = rings.get(serverId) ?? [];
  if (!lastEventId) return [];
  return ring.filter((event) => event.id > lastEventId);
}

export function subscribe(serverId: string, listener: (event: SseEvent) => void): () => void {
  const set = subscribers.get(serverId) ?? new Set();
  set.add(listener);
  subscribers.set(serverId, set);
  return () => {
    set.delete(listener);
  };
}

let idCounter = 0;
export function makeId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${idCounter.toString(36).padStart(3, "0")}${Math.floor(Date.now() % 1000)
    .toString(36)
    .padStart(2, "0")}`;
}

/** Seed one server that matches fixtures/rules/context.json. */
export function seed(): void {
  const serverId = "srv_7f2";
  servers.set(serverId, {
    server_id: serverId,
    name: "farlands-demo",
    hostname: "srv_7f2.mc.example.invalid",
    state: "running",
    player_count: 4,
    max_players: 20,
    tps: 19.8,
    current_version: 3,
    regions: ["spawn", "nether_hub", "mining_world"],
  });

  const otherId = "srv_a19";
  servers.set(otherId, {
    server_id: otherId,
    name: "not-yours",
    hostname: "srv_a19.mc.example.invalid",
    state: "running",
    player_count: 0,
    max_players: 20,
    tps: 20,
    current_version: 1,
    regions: [],
  });

  const baseDocument = {
    schema_version: 1,
    rules: [
      {
        rule: "mob_spawn_rate",
        id: "hostiles_near_spawn",
        mob: "zombie",
        region: "spawn",
        multiplier: 0.5,
      },
    ],
  };

  ruleVersions.set(serverId, [
    {
      version: 3,
      document: baseDocument,
      content_digest: contentDigest(baseDocument),
      source: "form",
      source_prompt: null,
      created_at: new Date().toISOString(),
    },
  ]);

  rollups.set(serverId, { ...EMPTY_ROLLUP_METRICS });
  telemetryReceived.set(serverId, 0);
}

export const DEPLOYMENT_ORDER: readonly DeploymentState[] = [
  "queued",
  "building",
  "staging",
  "presync",
  "freezing",
  "verifying",
  "cutover",
  "draining",
  "idle",
];
