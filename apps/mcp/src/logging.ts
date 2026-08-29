import type { ToolClass } from "@farlands/contracts";
import type { TransportKind } from "./caller.ts";

/**
 * One structured line per tool call.
 *
 * The `deployments` table stays the audit log of record for anything that
 * changed a world. This log answers a different question: what did the agent
 * try? A refused call leaves no row anywhere else, and a refusal that nobody can
 * see is indistinguishable from a tool that was never called.
 *
 * The logger is an interface because the tests assert on it. A test that has to
 * scrape stderr to prove logging happened will be deleted the first time it
 * flakes.
 */

export type ToolOutcomeKind = "ok" | "refused" | "error";

export interface ToolCallLog {
  event: "mcp_tool_call";
  ts: string;
  transport: TransportKind;
  caller: string;
  tool: string;
  tool_class: ToolClass | "unknown";
  arguments: Record<string, unknown>;
  outcome: ToolOutcomeKind;
  /** The refusal or error code, so a log search can count approval refusals. */
  code: string | null;
  duration_ms: number;
}

export interface ToolLogger {
  record(entry: ToolCallLog): void;
}

/** Argument keys whose values are credentials rather than data. */
const SECRET_KEYS = new Set(["approval_token"]);

/**
 * Log that a token was presented, never the token.
 *
 * An approval token is bearer authority over a live world for as long as it is
 * unspent. Writing it into an application log turns the log into a second place
 * that authority lives, which is a place nobody is guarding.
 */
export function redactArguments(args: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (SECRET_KEYS.has(key)) {
      redacted[key] = typeof value === "string" && value.length > 0 ? "[redacted]" : value;
      continue;
    }
    redacted[key] = value;
  }
  return redacted;
}

/**
 * Write to stderr, not stdout.
 *
 * Under the stdio transport stdout is the JSON-RPC frame stream. A log line
 * there is not a log line, it is a protocol violation.
 */
export function stderrToolLogger(
  write: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
): ToolLogger {
  return {
    record(entry) {
      write(JSON.stringify(entry));
    },
  };
}

export interface RecordingToolLogger extends ToolLogger {
  readonly entries: readonly ToolCallLog[];
  clear(): void;
}

export function recordingToolLogger(): RecordingToolLogger {
  const entries: ToolCallLog[] = [];
  return {
    entries,
    record(entry) {
      entries.push(entry);
    },
    clear() {
      entries.length = 0;
    },
  };
}
