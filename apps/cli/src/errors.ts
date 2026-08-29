/**
 * Exit codes and the one error type commands throw.
 *
 * The codes are distinct because the callers are scripts: a CI job that treats
 * "refused for want of an approval" the same as "the network was down" will
 * retry the one case that is guaranteed to fail again forever.
 */
export const EXIT = {
  ok: 0,
  /** Usage, configuration, transport: something the caller can fix. */
  error: 1,
  /** A structured refusal. Retrying changes nothing; ask a human. */
  refused: 2,
  /** The deployment ran and did not reach idle. */
  unsuccessful: 3,
  /** A watched state exceeded its stall budget and was left running. */
  stalled: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly hint: string | undefined;

  constructor(message: string, options: { exitCode?: ExitCode; hint?: string } = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = options.exitCode ?? EXIT.error;
    this.hint = options.hint;
  }
}
