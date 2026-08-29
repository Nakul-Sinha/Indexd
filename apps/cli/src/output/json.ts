import type { DeploymentStateEvent, Refusal } from "@farlands/contracts";
import type {
  DeploymentSummary,
  JsonRecord,
  LogLine,
  OutputPort,
  Sink,
  StallReport,
  View,
} from "./port.ts";

/**
 * The machine renderer: newline-delimited JSON on stdout and nothing else.
 *
 * Three properties hold together here, and they are structural rather than
 * agreed:
 *
 *   1. This module imports no colour helper. There is nothing in scope that
 *      could emit an escape sequence, so no future edit can add one absent-
 *      mindedly.
 *   2. stdout leaves this class through writeLine() and nowhere else, and
 *      writeLine() serializes with JSON.stringify. A caller cannot hand it a
 *      pre-rendered string.
 *   3. JSON.stringify escapes every code point below U+0020 as \uXXXX. A
 *      server-supplied detail string carrying a raw ESC therefore arrives on
 *      stdout as a six character backslash-u escape, which is data a consumer
 *      parses, not an instruction a terminal obeys.
 *
 * Human-facing chatter goes to stderr, where a consumer reading stdout never
 * sees it.
 */
export class JsonOutput implements OutputPort {
  readonly mode = "json" as const;

  constructor(
    private readonly stdout: Sink,
    private readonly stderr: Sink,
  ) {}

  private writeLine(value: JsonRecord): void {
    this.stdout(`${JSON.stringify(value)}\n`);
  }

  transition(event: DeploymentStateEvent): void {
    this.writeLine(event);
  }

  view(view: View): void {
    for (const record of view.records()) this.writeLine(record);
  }

  log(line: LogLine): void {
    this.writeLine({ event: "server_log", ...line });
  }

  note(text: string): void {
    this.stderr(`${text}\n`);
  }

  warn(text: string): void {
    this.stderr(`${text}\n`);
  }

  /**
   * Written unwrapped and unmodified. The refusal is a value the MCP act tools,
   * the deploy endpoint and this command all return identically, and wrapping it
   * in a CLI envelope here would make "byte for byte" quietly untrue.
   */
  refusal(value: Refusal): void {
    this.writeLine(value as unknown as JsonRecord);
  }

  stalled(report: StallReport): void {
    this.writeLine({ event: "deployment_stalled", ...report });
  }

  deploymentClosed(summary: DeploymentSummary): void {
    this.writeLine({ event: "deployment_closed", ...summary });
  }
}
