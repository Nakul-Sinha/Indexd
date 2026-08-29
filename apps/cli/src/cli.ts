import type { ArgsDef, CommandDef, Resolvable } from "citty";
import { defineCommand, renderUsage, runCommand } from "citty";
import type { FetchLike } from "./api.ts";
import { deployCommand } from "./commands/deploy.ts";
import { logsCommand } from "./commands/logs.ts";
import { rollbackCommand } from "./commands/rollback.ts";
import { rulesCommand } from "./commands/rules.ts";
import { serversCommand } from "./commands/servers.ts";
import type { CommandContext } from "./commands/shared.ts";
import { telemetryCommand } from "./commands/telemetry.ts";
import type { ExitCode } from "./errors.ts";
import { CliError, EXIT } from "./errors.ts";
import type { Sink } from "./output/index.ts";
import { createOutputPort, jsonRequested } from "./output/index.ts";
import type { CliRuntime } from "./runtime.ts";

export const CLI_NAME = "farlands";
export const CLI_VERSION = "0.1.0";

/**
 * Everything the binary needs from the world outside it.
 *
 * index.ts supplies the real implementations; the tests supply an Elysia app's
 * handle(), a fixed environment and two string collectors.
 */
export interface CliDeps {
  stdout: Sink;
  stderr: Sink;
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  readTextFile?: (path: string) => string | null;
  homeDir?: string | null;
  now?: () => number;
  /** Human mode only. Left undefined, picocolors decides from the terminal. */
  color?: boolean;
}

function buildTree(ctx: CommandContext) {
  return defineCommand({
    meta: {
      name: CLI_NAME,
      version: CLI_VERSION,
      description: "The game server control plane, as a terminal binary.",
    },
    subCommands: {
      servers: serversCommand(ctx),
      rules: rulesCommand(ctx),
      deploy: deployCommand(ctx),
      rollback: rollbackCommand(ctx),
      telemetry: telemetryCommand(ctx),
      logs: logsCommand(ctx),
    },
  });
}

/**
 * Run the CLI and return the exit code.
 *
 * The output port is constructed here, once, from a raw scan of argv, and every
 * command is handed the finished port. Nothing downstream can pick a renderer,
 * so --json cannot be broken by a command that forgot about it.
 *
 * Errors always go to stderr, and so does usage under --json. citty renders
 * usage with its own colours, and stdout under --json belongs to the consumer,
 * so the one place that ordinarily earns stdout gives it up in machine mode.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<ExitCode> {
  const json = jsonRequested(argv);
  const out = createOutputPort({
    json,
    stdout: deps.stdout,
    stderr: deps.stderr,
    ...(deps.color === undefined ? {} : { color: deps.color }),
  });

  const runtime: CliRuntime = {
    out,
    env: deps.env,
    fetch: deps.fetch,
    readTextFile: deps.readTextFile ?? (() => null),
    homeDir: deps.homeDir ?? null,
    now: deps.now ?? (() => Date.now()),
  };

  const ctx: CommandContext = { runtime, outcome: { exitCode: EXIT.ok } };
  const tree = buildTree(ctx);

  // Help is answered before dispatch, because a subcommand cannot render its own
  // usage: argument parsing rejects the missing positional first, and the caller
  // asking how to spell the command gets an error about spelling it wrong.
  if (helpRequested(argv)) {
    const usage = await renderUsage(await commandFor(tree, argv));
    (json ? deps.stderr : deps.stdout)(`${usage}\n`);
    return EXIT.ok;
  }

  try {
    await runCommand(tree, { rawArgs: [...argv] });
    return ctx.outcome.exitCode;
  } catch (error) {
    if (error instanceof CliError) {
      deps.stderr(`${CLI_NAME}: ${error.message}\n`);
      if (error.hint) deps.stderr(`${error.hint}\n`);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    deps.stderr(`${CLI_NAME}: ${message}\n`);
    if (isUsageProblem(error)) deps.stderr(`${await renderUsage(tree)}\n`);
    return EXIT.error;
  }
}

/**
 * Deliberately not a global --version scan.
 *
 * deploy takes --version as the rule set version to deploy, so a top level
 * handler for it would shadow the flag that matters most on the command that
 * matters most. The binary reports its version through the usage header instead.
 */
function helpRequested(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

async function resolveMaybe<T>(value: Resolvable<T> | undefined): Promise<T | undefined> {
  if (value === undefined) return undefined;
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : await value;
}

/** Walk the tree by its non-flag tokens, stopping at the first name that is not a command. */
async function commandFor(tree: CommandDef, argv: readonly string[]): Promise<CommandDef<ArgsDef>> {
  let current: CommandDef<ArgsDef> = tree;

  for (const token of argv) {
    if (token === "--") break;
    if (token.startsWith("-")) continue;
    const subCommands = await resolveMaybe(current.subCommands);
    const next = await resolveMaybe(subCommands?.[token]);
    if (!next) break;
    current = next;
  }

  return current;
}

/** citty tags its own argument and dispatch failures; those deserve the usage text. */
function isUsageProblem(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === "EARG" ||
    code === "E_NO_COMMAND" ||
    code === "E_UNKNOWN_COMMAND" ||
    code === "E_DEFAULT_CONFLICT"
  );
}
