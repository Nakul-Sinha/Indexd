import { defineCommand } from "citty";
import { apiFor } from "../runtime.ts";
import type { CommandContext } from "./shared.ts";
import { GLOBAL_ARGS } from "./shared.ts";

export function serversCommand(ctx: CommandContext) {
  const list = defineCommand({
    meta: { name: "list", description: "List the servers this token can see" },
    args: { ...GLOBAL_ARGS },
    async run() {
      const api = apiFor(ctx.runtime);
      const { items } = await api.listServers();

      ctx.runtime.out.view({
        records: () => items.map((server) => ({ event: "server", ...server })),
        table: () => ({
          columns: ["server", "name", "state", "players", "tps", "version"],
          rows: items.map((server) => [
            server.server_id,
            server.name,
            server.state,
            `${server.player_count}/${server.max_players}`,
            server.tps === null ? "-" : server.tps.toFixed(1),
            server.current_version === null ? "-" : `v${server.current_version}`,
          ]),
          footer:
            items.length === 0
              ? "No servers. Scoping is per token, so an empty list can also mean the wrong token."
              : undefined,
        }),
      });
    },
  });

  return defineCommand({
    meta: { name: "servers", description: "Servers you own" },
    subCommands: { list },
  });
}
