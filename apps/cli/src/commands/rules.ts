import { defineCommand } from "citty";
import { apiFor } from "../runtime.ts";
import type { CommandContext } from "./shared.ts";
import { GLOBAL_ARGS, requireServerId, SERVER_ARG } from "./shared.ts";

/**
 * Drafting is a draft-class operation: it produces a validated rule version and
 * deploys nothing. The description is quoted as data on the way to the authoring
 * pipeline, never joined into anything the CLI itself interprets.
 */
export function rulesCommand(ctx: CommandContext) {
  const author = defineCommand({
    meta: {
      name: "author",
      description: "Draft a new rule set version from a plain English description",
    },
    args: {
      server: SERVER_ARG,
      description: {
        type: "positional" as const,
        description: 'What the rules should do, quoted, for example "fewer zombies near spawn"',
      },
      ...GLOBAL_ARGS,
    },
    async run({ args }) {
      const api = apiFor(ctx.runtime);
      const serverId = requireServerId(args.server);
      const drafted = await api.authorRules(serverId, String(args.description));

      const record =
        typeof drafted === "object" && drafted !== null
          ? (drafted as Record<string, unknown>)
          : { result: drafted };

      ctx.runtime.out.view({
        records: () => [{ event: "rule_version_drafted", server_id: serverId, ...record }],
        table: () => ({
          columns: ["field", "value"],
          rows: Object.entries(record).map(([key, value]) => [
            key,
            typeof value === "string" ? value : JSON.stringify(value),
          ]),
          footer: `Nothing is live yet. Review it, then: farlands deploy ${serverId} --version N`,
        }),
      });
    },
  });

  return defineCommand({
    meta: { name: "rules", description: "Rule set authoring" },
    subCommands: { author },
  });
}
