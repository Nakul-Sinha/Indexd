/**
 * Telemetry ingest and rolling window aggregation.
 *
 * The one rule that shapes every file here: raw events are never stored. What
 * crosses this module's boundary outward is `WorldEventsRollup` and nothing
 * else, so downstream readers (the world telemetry tool, the CLI, the Director,
 * the evaluation harness, the proposals UI and the phone feed) all read the
 * same aggregate, and no volume of play makes the storage grow.
 */

export {
  type AggregatorOptions,
  DEFAULT_STORE_TIMEOUT_MS,
  DEFAULT_WINDOW_SECONDS,
  type IngestOutcome,
  TelemetryAggregator,
} from "./aggregator.ts";
export {
  type EventRejection,
  isWorldEvent,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  type ParsedBatch,
  parseNdjsonBatch,
} from "./events.ts";
export { EXTERNAL_ROUTING_HEADERS, externalRoutingHeader, internalOnlyRefusal } from "./guard.ts";
export {
  type TelemetryIngestResponse,
  type TelemetryPlugin,
  type TelemetryPluginOptions,
  telemetryPlugin,
} from "./plugin.ts";
export { DEFAULT_MAX_SESSION_SECONDS, SessionLedger } from "./sessions.ts";
export { InMemoryRollupStore, type RollupStore } from "./store.ts";
export { WindowAccumulator } from "./window.ts";
