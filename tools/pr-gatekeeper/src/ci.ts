/**
 * Continuous integration status, read rather than reproduced.
 *
 * The gate used to run the whole suite locally. That put a package manager on
 * the critical path of every merge decision, and on this machine bun install
 * intermittently produces broken symlinks and half extracted packages (issue
 * 26). The result was the worst kind of gate failure: it blocked correct pull
 * requests, and the reported reason (typecheck failed) pointed at the code
 * rather than at the environment.
 *
 * GitHub Actions already runs lint, typecheck, tests and the schema drift check
 * on every pull request, on a clean Linux runner, against the merge result. That
 * is a better answer to "does this pass" than anything reproducible here, so the
 * gate reads it instead of racing it.
 *
 * What stays local is the diff audit, which needs no dependencies at all.
 */

export interface CheckRun {
  name: string;
  bucket: string;
}

export type CiState = "passing" | "failing" | "pending" | "none";

export interface CiStatus {
  state: CiState;
  detail: string;
}

/**
 * Reduce the check runs to one verdict.
 *
 * Order matters: anything failing outranks anything pending, so a pull request
 * with one failed job and one still running reports as failing rather than
 * waiting forever on the job that will not change the answer.
 */
export function summariseChecks(checks: readonly CheckRun[]): CiStatus {
  if (checks.length === 0) {
    return {
      state: "none",
      detail: "no checks reported for this pull request",
    };
  }

  const failing = checks.filter((check) => check.bucket === "fail");
  if (failing.length > 0) {
    return {
      state: "failing",
      detail: `failing: ${failing.map((check) => check.name).join(", ")}`,
    };
  }

  const pending = checks.filter(
    (check) => check.bucket === "pending" || check.bucket === "waiting",
  );
  if (pending.length > 0) {
    return {
      state: "pending",
      detail: `still running: ${pending.map((check) => check.name).join(", ")}`,
    };
  }

  const passing = checks.filter((check) => check.bucket === "pass");
  return {
    state: "passing",
    detail: `${passing.length} check${passing.length === 1 ? "" : "s"} passed`,
  };
}
