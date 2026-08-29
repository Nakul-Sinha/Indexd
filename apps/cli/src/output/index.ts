import { HumanOutput } from "./human.ts";
import { JsonOutput } from "./json.ts";
import type { OutputPort, Sink } from "./port.ts";

export { HumanOutput } from "./human.ts";
export { JsonOutput } from "./json.ts";
export type {
  DeploymentSummary,
  JsonRecord,
  LogLine,
  OutputPort,
  Sink,
  StallReport,
  TableView,
  View,
} from "./port.ts";

export interface OutputOptions {
  json: boolean;
  stdout: Sink;
  stderr: Sink;
  /** Human mode only. Left undefined, picocolors decides from the terminal. */
  color?: boolean;
}

/**
 * Choose the renderer, once.
 *
 * Called before any command runs and never again, so no command can switch mode
 * partway through and leave a consumer holding half a stream. The --json flag is
 * read from the raw argv by jsonRequested() rather than from parsed arguments,
 * because argument parsing happens per subcommand and the decision has to be
 * made before that.
 */
export function createOutputPort(options: OutputOptions): OutputPort {
  if (options.json) return new JsonOutput(options.stdout, options.stderr);
  return new HumanOutput(options.stdout, options.stderr, { color: options.color });
}

/**
 * Deliberately a raw scan of argv rather than a parser.
 *
 * The flag decides where every subsequent byte goes, so it is resolved before
 * the command tree is consulted and cannot be affected by a subcommand's own
 * argument definitions.
 */
export function jsonRequested(argv: readonly string[]): boolean {
  let requested = false;
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg === "--json" || arg === "--json=true") requested = true;
    if (arg === "--json=false" || arg === "--no-json") requested = false;
  }
  return requested;
}
