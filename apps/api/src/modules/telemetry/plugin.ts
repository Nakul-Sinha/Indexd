import { ServerId } from "@farlands/contracts";
import { Elysia, getSchemaValidator } from "elysia";
import { type AggregatorOptions, TelemetryAggregator } from "./aggregator.ts";
import { MAX_BATCH_BYTES, MAX_BATCH_EVENTS, parseNdjsonBatch } from "./events.ts";
import { externalRoutingHeader, internalOnlyRefusal } from "./guard.ts";

/**
 * `POST /internal/telemetry/:serverId`.
 *
 * Shipped as a plugin rather than as an application so the shell owner mounts
 * it (`app.use(telemetryPlugin({ store }))`) without this module having an
 * opinion about ports, middleware order or anything else outside its seam.
 *
 * Three properties the handler is built around:
 *
 *   1. It cannot fail the emitter. A world whose ingest endpoint misbehaves
 *      keeps playing and drops events, so nothing here awaits persistence and
 *      nothing here throws on a store fault.
 *   2. It cannot accept an event the contract forbids. The validator is
 *      compiled from `WorldEvent` itself, not restated.
 *   3. It treats every string in the payload as opaque. Player names are
 *      counted and never read; not by the handler, not by the aggregator, and
 *      not by the error path, which reports schema paths rather than values.
 */

const serverIdValidator = getSchemaValidator(ServerId, {});

export interface TelemetryPluginOptions extends AggregatorOptions {
  /** Supply an aggregator to share one instance across routes. */
  aggregator?: TelemetryAggregator;
}

export interface TelemetryIngestResponse {
  server_id: string;
  accepted: number;
  rejected: number;
  /** Events whose window had already closed. Non-zero means batches are out of order. */
  late: number;
  /** Capped detail for the rejected lines, by line number and schema path. */
  rejections: { line: number; path: string; expected: string }[];
}

export function telemetryPlugin(options: TelemetryPluginOptions) {
  const aggregator = options.aggregator ?? new TelemetryAggregator(options);

  return new Elysia({ name: "farlands-telemetry" }).decorate("telemetry", aggregator).post(
    "/internal/telemetry/:serverId",
    async ({ params, request, headers, set }) => {
      // The guard runs before anything reads the body, so an externally
      // routed request costs one header lookup rather than a parse.
      const forwarded = externalRoutingHeader(headers);
      if (forwarded !== null) {
        set.status = 404;
        return internalOnlyRefusal(forwarded);
      }

      // A path segment becomes a store key, so it is validated against the
      // contract's ServerId rather than trusted because it came from a router.
      if (!serverIdValidator.Check(params.serverId)) {
        set.status = 404;
        return {
          error: "not_found" as const,
          tool: "telemetry_ingest",
          resource: "server",
          message: "That server id is not a valid server id.",
          resolution: "Post to /internal/telemetry/{server_id} using the id issued for the world.",
        };
      }

      const body = await request.text();
      if (body.length > MAX_BATCH_BYTES) {
        set.status = 413;
        return {
          error: "batch_too_large" as const,
          limit_bytes: MAX_BATCH_BYTES,
          limit_events: MAX_BATCH_EVENTS,
          message: "Telemetry batch exceeded the size limit and was not read.",
          resolution: `Send at most ${MAX_BATCH_EVENTS} events per batch.`,
        };
      }

      const batch = parseNdjsonBatch(body);
      if (batch.oversized) {
        set.status = 413;
        return {
          error: "batch_too_large" as const,
          limit_bytes: MAX_BATCH_BYTES,
          limit_events: MAX_BATCH_EVENTS,
          message: "Telemetry batch exceeded the event limit and was not read.",
          resolution: `Send at most ${MAX_BATCH_EVENTS} events per batch.`,
        };
      }

      // Synchronous: counters only. The store is written on the aggregator's
      // own chain, so a database outage cannot slow this response down.
      const outcome = aggregator.ingest(params.serverId, batch.events);

      const response: TelemetryIngestResponse = {
        server_id: params.serverId,
        accepted: outcome.accepted,
        rejected: batch.rejections.length,
        late: outcome.late,
        rejections: batch.rejections,
      };

      // Partial success stays a 200 because one bad line in a batch of a
      // hundred is not a failed request. A batch that produced nothing usable
      // is a different outcome and says so, so a broken emitter is visible
      // instead of looking like a quiet world.
      if (outcome.accepted === 0 && batch.rejections.length > 0) set.status = 422;

      return response;
    },
    // NDJSON is not a shape Elysia's body parsers understand, and the
    // emitter's content-type must not decide whether a batch is readable.
    // Reading the request directly makes the route indifferent to it.
    { parse: "none" },
  );
}

export type TelemetryPlugin = ReturnType<typeof telemetryPlugin>;
