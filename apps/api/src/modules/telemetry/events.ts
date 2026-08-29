import { WorldEvent } from "@farlands/contracts";
import { getSchemaValidator } from "elysia";

/**
 * NDJSON parsing and contract validation for the ingest endpoint.
 *
 * The validator is compiled once from the contract schema rather than
 * hand-written here. A hand-written check drifts from the contract silently,
 * and the first symptom of that drift is a rollup whose numbers nobody can
 * explain. Compiling the contract means a field the contract forbids cannot be
 * accepted, including fields a future emitter adds without a contract change.
 */

const validator = getSchemaValidator(WorldEvent, {});

/** Matches TelemetryBatch.events maxItems, so both surfaces refuse at the same point. */
export const MAX_BATCH_EVENTS = 1000;

/**
 * A ceiling on the raw body, because the network policy that keeps this
 * endpoint cluster-internal is enforced elsewhere (see guard.ts) and a size
 * limit is one of the few controls this module can enforce by itself.
 * 1 MiB is roughly six times a full 1000-event batch.
 */
export const MAX_BATCH_BYTES = 1_048_576;

/**
 * Why one line was refused.
 *
 * The offending value is deliberately absent. Every rejection here is caused by
 * player-adjacent data, and a reason string that quoted the value would put
 * player-authored text into a log line that a human or a model may later read.
 * The line number and the schema path locate the problem without reflecting it.
 */
export interface EventRejection {
  /** 1-based index of the NDJSON line. */
  line: number;
  /** Schema path, such as "/player_name", or "/" for a line that is not JSON. */
  path: string;
  /** What the contract expected. Never what arrived. */
  expected: string;
}

export interface ParsedBatch {
  events: WorldEvent[];
  rejections: EventRejection[];
  /** True when the batch exceeded MAX_BATCH_EVENTS and was refused whole. */
  oversized: boolean;
}

/** Rejection detail is capped so a batch of garbage cannot generate a large response. */
const MAX_REPORTED_REJECTIONS = 10;

function firstError(value: unknown): { path: string; expected: string } {
  for (const error of validator.Errors(value)) {
    return { path: error.path === "" ? "/" : error.path, expected: error.message };
  }
  return { path: "/", expected: "Expected a WorldEvent" };
}

/**
 * Parse an NDJSON batch, keeping the well formed events and describing the rest.
 *
 * Partial success is intentional. The emitter batches, so one corrupt line
 * inside a batch of a hundred is a reason to drop that line, not to lose the
 * other ninety-nine. The caller decides what status a fully rejected batch gets.
 */
export function parseNdjsonBatch(text: string): ParsedBatch {
  const events: WorldEvent[] = [];
  const rejections: EventRejection[] = [];

  const lines = text.split("\n");
  let lineNumber = 0;
  let seen = 0;

  for (const raw of lines) {
    lineNumber += 1;
    const line = raw.trim();
    // Blank lines are ordinary in NDJSON, including the trailing newline every
    // well behaved writer emits. They are not events and are not errors.
    if (line === "") continue;

    seen += 1;
    if (seen > MAX_BATCH_EVENTS) {
      return { events: [], rejections: [], oversized: true };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (rejections.length < MAX_REPORTED_REJECTIONS) {
        rejections.push({ line: lineNumber, path: "/", expected: "Expected valid JSON" });
      }
      continue;
    }

    if (!validator.Check(parsed)) {
      if (rejections.length < MAX_REPORTED_REJECTIONS) {
        const { path, expected } = firstError(parsed);
        rejections.push({ line: lineNumber, path, expected });
      }
      continue;
    }

    // The cast is safe only because Check just passed against the contract
    // schema; nothing else in this module may assert this shape.
    events.push(parsed as WorldEvent);
  }

  return { events, rejections, oversized: false };
}

/** Single-event validation, exported so callers other than ingest share one gate. */
export function isWorldEvent(value: unknown): value is WorldEvent {
  return validator.Check(value);
}
