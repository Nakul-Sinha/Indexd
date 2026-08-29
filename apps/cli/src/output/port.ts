import type { DeploymentState, DeploymentStateEvent, Refusal } from "@farlands/contracts";

/**
 * The output port: the one seam between "what happened" and "how it is written".
 *
 * Two renderers implement this and exactly one of them is constructed, once, in
 * createOutputPort(). Commands are handed the interface and never a concrete
 * renderer, so a command has no colour helper and no stdout handle in scope to
 * misuse. That is the point: the --json purity rule stops being a convention
 * somebody has to remember during review and becomes a property of what is
 * reachable from a command body.
 */

/** Where a rendered chunk goes. Injected, so tests capture it without a pipe. */
export type Sink = (chunk: string) => void;

export type JsonRecord = Record<string, unknown>;

export interface TableView {
  columns: string[];
  rows: string[][];
  /** Printed under the table in human mode. Dropped under --json. */
  footer?: string;
}

/**
 * A listing, expressed once in both shapes and rendered lazily.
 *
 * The alternative, a command that builds a table and separately builds records,
 * duplicates the projection at every callsite and lets the two drift. Here the
 * port asks for the one it needs and the other is never evaluated.
 */
export interface View {
  records: () => JsonRecord[];
  table: () => TableView;
}

export interface LogLine {
  server_id: string;
  stream: "stdout" | "stderr";
  line: string;
  ts: string;
}

/**
 * A stall: the watched deployment sat in one state past its budget.
 *
 * budget_source is on the record rather than implied because the budgets are
 * provisional, and a consumer that cannot tell a provisional budget from a
 * measured one will quote it as though it were measured.
 */
export interface StallReport {
  deployment_id: string;
  server_id: string;
  state: DeploymentState;
  budget_ms: number;
  elapsed_ms: number;
  budget_source: "provisional";
  policy: "report" | "abort";
  ts: string;
}

export interface DeploymentSummary {
  deployment_id: string;
  server_id: string;
  final_state: DeploymentState;
  elapsed_ms: number;
  /** The exact command that undoes this, printed where the owner can see it. */
  rollback_command: string;
  ts: string;
}

export interface OutputPort {
  readonly mode: "human" | "json";

  /** One canonical state transition. Under --json this is the whole of stdout. */
  transition(event: DeploymentStateEvent): void;

  /** A listing or a one-off result. */
  view(view: View): void;

  /** One line of server console output. */
  log(line: LogLine): void;

  /** Human chatter. Never reaches stdout under --json. */
  note(text: string): void;

  /** Something went wrong but the command continues. Always stderr. */
  warn(text: string): void;

  /** The structured refusal, emitted as the contract constructor produced it. */
  refusal(value: Refusal): void;

  stalled(report: StallReport): void;

  /** Close out a watched deployment: the totals and the rollback command. */
  deploymentClosed(summary: DeploymentSummary): void;
}
