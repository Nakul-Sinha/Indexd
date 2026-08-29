import type { ApprovalRequiredRefusal } from "@farlands/contracts";
import { approvalRequired } from "@farlands/contracts";
import type { ApiClient } from "../api.ts";
import type { ExitCode } from "../errors.ts";
import { CliError } from "../errors.ts";
import type { CliRuntime } from "../runtime.ts";

/**
 * The pieces the act commands share, and the reason they share them.
 *
 * deploy and rollback must fail without an approval token exactly as the MCP act
 * tools do: the same body, byte for byte. That holds because both call
 * approvalRequired() from the contracts package and neither assembles the object
 * itself. A hand-written literal here would pass review, match the shape, and
 * differ in one wording or one key order the first time the constructor is
 * edited. So the constructor is the only source, here and in apps/mcp and in the
 * API, and this module never touches its output.
 */

export const GLOBAL_ARGS = {
  json: {
    type: "boolean" as const,
    description: "Write newline-delimited JSON to stdout. No colour, no chatter, no banner.",
    default: false,
  },
} as const;

export const SERVER_ARG = {
  type: "positional" as const,
  description: "Server id, for example srv_7f2",
} as const;

export interface ActTarget {
  serverId: string;
  version: number;
  digest: string;
}

/** The version being deployed, with the digest an approval would be bound to. */
export async function resolveDeployTarget(
  api: ApiClient,
  serverId: string,
  version: number,
): Promise<ActTarget> {
  const { items } = await api.listRuleSets(serverId);
  const match = items.find((entry) => entry.version === version);
  if (!match) {
    const known = items.map((entry) => entry.version).join(", ") || "none";
    throw new CliError(`${serverId} has no rule set version ${version}.`, {
      hint: `Versions on this server: ${known}. Draft a new one with: farlands rules author ${serverId} "..."`,
    });
  }
  return { serverId, version, digest: match.content_digest };
}

/**
 * The version a rollback would deploy.
 *
 * Rollback is an ordinary deployment with source and target reversed, so it
 * needs an approval token like any other, and it needs a digest to bind that
 * approval to. The preview endpoint names the target; the rule set list supplies
 * that version's digest when it is still listed.
 */
export async function resolveRollbackTarget(api: ApiClient, serverId: string): Promise<ActTarget> {
  const preview = await api.preview(serverId);
  const target = preview.rollback_target;
  if (target === null) {
    throw new CliError(`${serverId} has no earlier rule set version to roll back to.`, {
      hint: "Rollback restores the previous rule version. A server on its first version has nothing to restore.",
    });
  }
  const { items } = await api.listRuleSets(serverId);
  const match = items.find((entry) => entry.version === target);
  return { serverId, version: target, digest: match?.content_digest ?? preview.content_digest };
}

/**
 * The refusal for an act command with no approval token.
 *
 * Built and returned before any write is attempted. The CLI could send the call
 * and let the API refuse it, and it does exactly that whenever a token is
 * present but not valid. With no token at all there is nothing to check
 * server-side, so refusing here means the binary cannot be the thing that turns
 * a missing approval into a request against a live world.
 */
export function refuseWithoutApproval(
  tool: "deploy_rules" | "rollback",
  target: ActTarget,
): ApprovalRequiredRefusal {
  return approvalRequired({
    reason: "missing",
    tool,
    server_id: target.serverId,
    rule_set_version: target.version,
    content_digest: target.digest,
  });
}

export function rollbackCommandFor(serverId: string): string {
  return `farlands rollback ${serverId}`;
}

/** citty hands positionals through as strings; act commands need a version. */
export function parseVersion(raw: string | undefined): number {
  const version = Number(raw);
  if (!raw || !Number.isInteger(version) || version < 1) {
    throw new CliError(`--version must be a positive integer, got ${raw ?? "nothing"}.`);
  }
  return version;
}

export function requireServerId(raw: string | undefined): string {
  if (!raw) throw new CliError("A server id is required, for example srv_7f2.");
  return raw;
}

/**
 * What a command body is given.
 *
 * citty does not forward its data bag to subcommands, so the command tree is
 * built by a factory that closes over this instead. The exit code lives in a box
 * because citty also discards a subcommand's return value, and the difference
 * between "refused" and "the network was down" has to survive back to the shell.
 */
export interface CommandContext {
  runtime: CliRuntime;
  outcome: { exitCode: ExitCode };
}
