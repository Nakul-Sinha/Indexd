import { type Static, Type } from "@sinclair/typebox";
import { DeploymentId, ProposalId, ServerId, Timestamp } from "./common.ts";
import { DeploymentState } from "./deployment.ts";
import { RollupMetrics } from "./telemetry.ts";

/**
 * The SSE envelope, consumed by the web app, the phone and the CLI.
 *
 * Engineer 3 owns the stream; Engineer 2 publishes deployment states into it and
 * Engineer 1 publishes proposal events. One envelope, so a client that can read
 * one event kind can read them all.
 *
 * The id is monotonic per server and is what a client sends back as
 * Last-Event-ID. Resuming from an id the in-memory ring has already dropped
 * falls back to reconstruction from the database, so a phone that was closed
 * overnight resumes rather than restarts.
 */

const Envelope = <T extends string, D extends ReturnType<typeof Type.Object>>(type: T, data: D) =>
  Type.Object({
    id: Type.String({ description: "Monotonic per server. Sent back as Last-Event-ID." }),
    type: Type.Literal(type),
    server_id: ServerId,
    ts: Timestamp,
    data,
  });

export const DeploymentStateSseEvent = Envelope(
  "deployment_state",
  Type.Object({
    deployment_id: DeploymentId,
    state: DeploymentState,
    detail: Type.Union([Type.String(), Type.Null()]),
    queue_position: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  }),
);

export const WorldActivitySseEvent = Envelope(
  "world_activity",
  Type.Object({
    window_start: Timestamp,
    window_end: Timestamp,
    metrics: RollupMetrics,
  }),
);

export const ProposalCreatedSseEvent = Envelope(
  "proposal_created",
  Type.Object({
    proposal_id: ProposalId,
    summary: Type.String(),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  }),
);

export const ServerLogSseEvent = Envelope(
  "server_log",
  Type.Object({
    line: Type.String(),
    stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]),
  }),
);

/**
 * Heartbeat. SSE connections through a load balancer die silently without
 * traffic, and a phone cannot tell a quiet world from a dead socket.
 */
export const HeartbeatSseEvent = Envelope("heartbeat", Type.Object({}));

export const SseEvent = Type.Union([
  DeploymentStateSseEvent,
  WorldActivitySseEvent,
  ProposalCreatedSseEvent,
  ServerLogSseEvent,
  HeartbeatSseEvent,
]);
export type SseEvent = Static<typeof SseEvent>;

export type DeploymentStateSseEvent = Static<typeof DeploymentStateSseEvent>;
export type WorldActivitySseEvent = Static<typeof WorldActivitySseEvent>;
export type ProposalCreatedSseEvent = Static<typeof ProposalCreatedSseEvent>;
export type ServerLogSseEvent = Static<typeof ServerLogSseEvent>;
export type HeartbeatSseEvent = Static<typeof HeartbeatSseEvent>;

/** Serialize one event as an SSE frame, including the id line for replay. */
export function toSseFrame(event: SseEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
