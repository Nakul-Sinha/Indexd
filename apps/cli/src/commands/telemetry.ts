import { defineCommand } from "citty";
import { apiFor } from "../runtime.ts";
import type { CommandContext } from "./shared.ts";
import { GLOBAL_ARGS, requireServerId, SERVER_ARG } from "./shared.ts";

/**
 * Aggregated world activity for one server.
 *
 * Rollups only. There are no raw events to ask for, and that is deliberate
 * rather than a gap: this is a behavioural record of named players, so the
 * smallest thing that answers the question is the right thing to return.
 */
export function telemetryCommand(ctx: CommandContext) {
  return defineCommand({
    meta: { name: "telemetry", description: "Aggregated world activity for a server you own" },
    args: {
      server: SERVER_ARG,
      window: {
        type: "enum" as const,
        description: "Rollup window",
        options: ["1h", "6h", "24h"],
        default: "1h",
      },
      ...GLOBAL_ARGS,
    },
    async run({ args }) {
      const api = apiFor(ctx.runtime);
      const serverId = requireServerId(args.server);
      const window = String(args.window);
      const rollup = await api.telemetry(serverId, window);
      const metrics = rollup.metrics;

      ctx.runtime.out.view({
        records: () => [{ event: "world_activity", window, ...rollup }],
        table: () => ({
          columns: ["metric", "value"],
          rows: [
            ["joins", String(metrics.joins)],
            ["leaves", String(metrics.leaves)],
            ["deaths", String(metrics.deaths)],
            ["blocks placed", String(metrics.blocks_placed)],
            ["blocks broken", String(metrics.blocks_broken)],
            ["chat messages", String(metrics.chat_messages)],
            ["unique players", String(metrics.unique_players)],
            [
              "mean session",
              metrics.mean_session_seconds === null
                ? "-"
                : `${metrics.mean_session_seconds.toFixed(0)}s`,
            ],
            ...Object.entries(metrics.seconds_in_region).map(
              ([region, secondsInRegion]): string[] => [
                `time in ${region}`,
                `${secondsInRegion.toFixed(0)}s`,
              ],
            ),
          ],
          footer: `${rollup.window_start} to ${rollup.window_end}`,
        }),
      });
    },
  });
}
