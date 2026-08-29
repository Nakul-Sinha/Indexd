import type { SseEvent } from "@farlands/contracts";
import type { ApiClient } from "./api.ts";

/**
 * The SSE reader, with Last-Event-ID resume.
 *
 * A deployment outlives a socket. A laptop sleeps, a load balancer recycles an
 * idle connection, a proxy trims a long-lived response, and the deployment
 * carries on regardless. So the reader tracks the last id it saw and sends it
 * back on reconnect, which is what the API's ring buffer replays from. Without
 * the resume, a dropped socket silently turns into a missing transition and a
 * watch loop that thinks the deployment stalled.
 */

export interface SseFrame {
  id: string | null;
  event: string | null;
  data: string;
}

const ABORTED = Symbol("aborted");

/**
 * One abort promise for the whole read, raced against each chunk.
 *
 * A subscription has no natural end, so the only thing that ends a read is the
 * caller deciding it is done. Creating a fresh listener per chunk would leak one
 * per frame on a long deployment, so the promise is made once and reused.
 */
function abortSignalPromise(signal: AbortSignal | undefined): Promise<typeof ABORTED> | null {
  if (!signal) return null;
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(ABORTED);
      return;
    }
    signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
  });
}

/** Parse a byte stream into SSE frames. Blank line terminates a frame. */
export async function* readFrames(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const aborted = abortSignalPromise(signal);
  let buffer = "";

  try {
    while (true) {
      const next = reader.read();
      // Aborting the request rejects the read that was in flight. The race below
      // has already resolved by then, so the rejection needs an owner or it
      // surfaces as an unhandled rejection during an ordinary teardown.
      next.catch(() => undefined);
      const chunk = aborted ? await Promise.race([next, aborted]) : await next;
      if (chunk === ABORTED) break;
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const frame = parseFrame(block);
        if (frame) yield frame;
        separator = buffer.indexOf("\n\n");
      }
    }
  } finally {
    // Release the reader and let the abort signal carried on the request tear
    // the connection down. Teardown has to happen at the transport, not by
    // cancelling the response body: a subscription that is merely stopped from
    // the consumer end leaves the socket open, and a watch that reached idle
    // would then hold the process alive with nothing left to read.
    reader.releaseLock();
  }
}

function parseFrame(block: string): SseFrame | null {
  let id: string | null = null;
  let event: string | null = null;
  const data: string[] = [];

  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  if (id === null && event === null && data.length === 0) return null;
  return { id, event, data: data.join("\n") };
}

export interface EventStreamOptions {
  serverId: string;
  /** Reconnect attempts after the stream ends or faults. */
  maxReconnects?: number;
  signal?: AbortSignal;
  onReconnect?: (lastEventId: string | null, attempt: number) => void;
}

/**
 * Contract-typed events for one server, resuming across reconnects.
 *
 * Yields whatever the envelope carries; filtering by type is the caller's job,
 * because a heartbeat is meaningful to a watch loop even though it is not a
 * deployment transition.
 */
export async function* subscribe(
  api: ApiClient,
  options: EventStreamOptions,
): AsyncGenerator<SseEvent, void, undefined> {
  const maxReconnects = options.maxReconnects ?? 5;
  let lastEventId: string | null = null;
  let attempt = 0;

  while (!options.signal?.aborted) {
    const openOptions: { lastEventId?: string | null; signal?: AbortSignal } = { lastEventId };
    if (options.signal) openOptions.signal = options.signal;

    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await api.openEvents(options.serverId, openOptions);
    } catch (error) {
      if (attempt >= maxReconnects) throw error;
      attempt += 1;
      options.onReconnect?.(lastEventId, attempt);
      continue;
    }

    try {
      for await (const frame of readFrames(stream, options.signal)) {
        if (frame.id) lastEventId = frame.id;
        if (!frame.data) continue;
        const parsed = parseEvent(frame.data);
        if (parsed) yield parsed;
      }
    } catch {
      // A faulted socket is the ordinary case this loop exists for, not an
      // exceptional one. Fall through to the reconnect below.
    }

    if (options.signal?.aborted) return;
    if (attempt >= maxReconnects) return;
    attempt += 1;
    options.onReconnect?.(lastEventId, attempt);
  }
}

function parseEvent(data: string): SseEvent | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!("type" in parsed) || !("server_id" in parsed)) return null;
    return parsed as SseEvent;
  } catch {
    return null;
  }
}
