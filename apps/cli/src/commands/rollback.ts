import { defineCommand } from "citty";
import { resolveApprovalToken } from "../auth.ts";
import { CliError, EXIT } from "../errors.ts";
import { apiFor, credentialSources } from "../runtime.ts";
import { startAndFollow } from "./deploy.ts";
import type { CommandContext } from "./shared.ts";
import {
  GLOBAL_ARGS,
  refuseWithoutApproval,
  requireServerId,
  resolveRollbackTarget,
  SERVER_ARG,
} from "./shared.ts";

/**
 * Rollback restores the previous rule version onto the running world.
 *
 * It is an act-class command and it gates exactly like deploy, which is the
 * point: an agent that could roll back without approval could still change what
 * a world does. Note what it does not claim to do. It stops a rule acting
 * further; it does not undo what the rule already did, and the human-mode note
 * says so rather than letting "rollback" imply more than it delivers.
 */
export function rollbackCommand(ctx: CommandContext) {
  return defineCommand({
    meta: {
      name: "rollback",
      description: "Restore the previous rule set version. Requires an approval token.",
    },
    args: {
      server: SERVER_ARG,
      watch: {
        type: "boolean" as const,
        description: "Follow the rollback, one line per state transition",
        default: false,
      },
      "on-stall": {
        type: "enum" as const,
        description: "What to do when a state exceeds its provisional stall budget",
        options: ["report", "abort"],
        default: "report",
      },
      "stall-budget-ms": {
        type: "string" as const,
        description: "Override the provisional per-state stall budget, in milliseconds",
      },
      ...GLOBAL_ARGS,
    },
    async run({ args }) {
      const api = apiFor(ctx.runtime);
      const serverId = requireServerId(args.server);
      const target = await resolveRollbackTarget(api, serverId);

      const approvalToken = resolveApprovalToken(credentialSources(ctx.runtime));
      if (!approvalToken) {
        ctx.runtime.out.refusal(refuseWithoutApproval("rollback", target));
        ctx.outcome.exitCode = EXIT.refused;
        return;
      }

      ctx.runtime.out.note(
        `Rolling ${serverId} back to v${target.version}. This stops the newer rules acting; it does not undo what they already did.`,
      );

      ctx.outcome.exitCode = await startAndFollow(ctx, {
        api,
        target,
        start: () => api.rollback(serverId, { approval_token: approvalToken }),
        watch: Boolean(args.watch),
        onStall: args["on-stall"] === "abort" ? "abort" : "report",
        stallBudgetMs: parseOptionalMs(args["stall-budget-ms"]),
        pollIntervalMs: null,
      });
    },
  });
}

function parseOptionalMs(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError(`--stall-budget-ms must be a positive number, got ${String(raw)}.`);
  }
  return value;
}
