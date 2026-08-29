import { defineCommand } from "citty";
import { CliError } from "../errors.ts";
import { apiFor } from "../runtime.ts";
import { subscribe } from "../sse.ts";
import type { CommandContext } from "./shared.ts";
import { GLOBAL_ARGS, requireServerId, SERVER_ARG } from "./shared.ts";

/**
 * Server console output, from the same SSE envelope everything else uses.
 *
 * One stream carries deployment states, world activity, proposals and log
 * lines, so a client that can read one kind can read them all, and Last-Event-ID
 * resume works here for free. A console line is untrusted text from a running
 * game: it is written out, never interpreted, and under --json it is a JSON
 * string field, which is what keeps a log line from steering a terminal.
 */
export function logsCommand(ctx: CommandContext) {
  return defineCommand({
    meta: { name: "logs", description: "Server console output" },
    args: {
      server: SERVER_ARG,
      follow: {
        type: "boolean" as const,
        description: "Keep the stream open and print lines as they arrive",
        default: false,
      },
      "idle-timeout-ms": {
        type: "string" as const,
        description: "Without --follow, stop after this long with no line. Ignored when following.",
        default: "1000",
      },
      ...GLOBAL_ARGS,
    },
    async run({ args }) {
      const api = apiFor(ctx.runtime);
      const serverId = requireServerId(args.server);
      const follow = Boolean(args.follow);
      const idleTimeoutMs = parseIdleTimeout(args["idle-timeout-ms"]);

      const controller = new AbortController();
      // Without --follow the stream still has no natural end, because it is a
      // subscription and not a query. Replay everything the ring holds, then
      // stop once it goes quiet. GET /v1/servers/:id/logs is the endpoint that
      // makes this a bounded read; until it exists, the quiet window is the
      // honest approximation and it is under the caller's control.
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const resetIdle = () => {
        if (follow) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
      };
      resetIdle();

      try {
        for await (const event of subscribe(api, {
          serverId,
          signal: controller.signal,
          // A log tail that silently reconnects forever hides an outage. One
          // pass of retries, then say so.
          maxReconnects: follow ? 5 : 0,
          onReconnect: (lastEventId) => {
            ctx.runtime.out.warn(`log stream dropped, resuming from ${lastEventId ?? "the start"}`);
          },
        })) {
          resetIdle();
          if (event.type !== "server_log") continue;
          ctx.runtime.out.log({
            server_id: event.server_id,
            stream: event.data.stream,
            line: event.data.line,
            ts: event.ts,
          });
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        controller.abort();
      }
    },
  });
}

function parseIdleTimeout(raw: unknown): number {
  const value = Number(raw ?? 1000);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError(`--idle-timeout-ms must be a positive number, got ${String(raw)}.`);
  }
  return value;
}
