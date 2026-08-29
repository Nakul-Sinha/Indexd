import type { DeploymentStateEvent, Refusal } from "@farlands/contracts";
import { isTerminal } from "@farlands/contracts";
import pc from "picocolors";
import type {
  DeploymentSummary,
  LogLine,
  OutputPort,
  Sink,
  StallReport,
  TableView,
  View,
} from "./port.ts";

/**
 * The human renderer.
 *
 * A renderer and not an application: no TUI framework, no alternate screen, no
 * spinner. A deployment is a list of named steps with timings that appends as
 * the states arrive, which is the shape that also survives being piped to a file
 * or scrolled back to after the fact.
 *
 * This is the only module in the CLI that imports a colour helper. Under --json
 * it is never constructed, so the escape sequences it can produce have no path
 * to stdout at all.
 */

type Colors = ReturnType<typeof pc.createColors>;

const STEP_COLUMN = 12;
const ELAPSED_COLUMN = 9;

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

export class HumanOutput implements OutputPort {
  readonly mode = "human" as const;

  private readonly colors: Colors;
  /**
   * Timings come from the transition timestamps rather than from a clock read
   * here, so the table and the NDJSON stream cannot disagree about when a state
   * was entered. Null also doubles as "no header printed yet", because the first
   * transition is exactly the moment both become true.
   */
  private firstTransitionMs: number | null = null;

  constructor(
    private readonly stdout: Sink,
    private readonly stderr: Sink,
    options: { color?: boolean } = {},
  ) {
    this.colors = options.color === undefined ? pc : pc.createColors(options.color);
  }

  private line(text = ""): void {
    this.stdout(`${text}\n`);
  }

  transition(event: DeploymentStateEvent): void {
    const at = Date.parse(event.ts);
    if (this.firstTransitionMs === null) {
      this.firstTransitionMs = Number.isNaN(at) ? 0 : at;
      this.line();
      this.line(
        this.colors.dim(
          `  ${pad("step", STEP_COLUMN)}${padStart("elapsed", ELAPSED_COLUMN)}  detail`,
        ),
      );
    }

    const elapsed = Number.isNaN(at) ? 0 : at - this.firstTransitionMs;
    const step = this.colors.bold(pad(event.state, STEP_COLUMN));
    const offset = this.colors.dim(padStart(seconds(elapsed), ELAPSED_COLUMN));
    const detail = event.detail === null ? "" : this.colors.dim(event.detail);
    this.line(`  ${step}${offset}  ${detail}`);
  }

  view(view: View): void {
    this.table(view.table());
  }

  private table(table: TableView): void {
    const widths = table.columns.map((column, index) =>
      Math.max(column.length, ...table.rows.map((row) => (row[index] ?? "").length)),
    );
    const render = (cells: string[]) =>
      cells
        .map((cell, index) => pad(cell, widths[index] ?? cell.length))
        .join("  ")
        .trimEnd();

    this.line();
    this.line(`  ${this.colors.dim(render(table.columns))}`);
    for (const row of table.rows) this.line(`  ${render(row)}`);
    if (table.footer) {
      this.line();
      this.line(`  ${table.footer}`);
    }
    this.line();
  }

  log(line: LogLine): void {
    const stamp = this.colors.dim(line.ts);
    const body = line.stream === "stderr" ? this.colors.yellow(line.line) : line.line;
    this.line(`${stamp}  ${body}`);
  }

  note(text: string): void {
    this.line(text);
  }

  warn(text: string): void {
    this.stderr(`${this.colors.yellow("warning")} ${text}\n`);
  }

  /**
   * Rendered so a person reading over someone's shoulder understands in five
   * seconds why the command stopped, and what to do that is not "retry".
   */
  refusal(value: Refusal): void {
    this.line();
    this.line(`  ${this.colors.red(this.colors.bold("refused"))}  ${value.error}`);
    this.line(`  ${value.message}`);
    this.line();
    this.line(`  ${this.colors.bold("what to do")}`);
    this.line(`  ${value.resolution}`);
    this.line();
  }

  stalled(report: StallReport): void {
    this.line();
    this.line(
      `  ${this.colors.yellow(this.colors.bold("stalled"))}  ${report.state} has not advanced in ${seconds(report.elapsed_ms)}`,
    );
    // Said out loud on every stall, deliberately. The budget is a placeholder
    // until the M1 measurement lands, and a line that reads like a measurement
    // gets quoted back as one.
    this.line(
      this.colors.dim(
        `  the ${seconds(report.budget_ms)} budget for ${report.state} is provisional, not measured`,
      ),
    );
    this.line(
      report.policy === "abort"
        ? "  aborting, because --on-stall abort was requested"
        : "  leaving it running. Pass --on-stall abort to abort automatically.",
    );
    this.line();
  }

  deploymentClosed(summary: DeploymentSummary): void {
    // A deployment the watch stopped following is not a deployment that
    // finished. Saying "finished in presync" would tell an owner the opposite of
    // what is true, which is that something is still running out there.
    const verb = isTerminal(summary.final_state) ? "finished in" : "still running, left in";
    this.line();
    this.line(
      `  ${summary.server_id} ${verb} ${this.colors.bold(summary.final_state)} after ${seconds(summary.elapsed_ms)} (${summary.deployment_id})`,
    );
    // Printed on every outcome, not only the bad ones. The owner who needs it
    // most is the one who did not expect to need it.
    this.line();
    this.line(
      `  ${this.colors.dim("to undo this:")}  ${this.colors.bold(summary.rollback_command)}`,
    );
    this.line();
  }
}
