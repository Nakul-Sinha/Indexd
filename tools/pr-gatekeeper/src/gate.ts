import { $ } from "bun";
import { auditDiff, blockers, type Finding } from "./checks.ts";
import { decide, type PullRequestFacts } from "./policy.ts";

/**
 * The gatekeeper run loop.
 *
 * For each open pull request: fetch it, resolve conflicts with main if it has
 * any, run the full quality gate, run the mechanical audit, then merge or
 * comment. It never merges on a failure and never merges what policy.ts says a
 * human owns.
 *
 * Untrusted input, stated plainly: the title, body, branch name and diff are all
 * written by whoever opened the pull request. Nothing here interprets any of
 * them as instructions. The audit reads the diff as text and matches patterns;
 * commands are never built from pull request content.
 */

export interface GateOptions {
  /** Report what would happen without merging, commenting or pushing. */
  dryRun: boolean;
  /** Restrict the run to one pull request. */
  only?: number;
}

export interface GateResult {
  number: number;
  title: string;
  author: string;
  outcome: "merged" | "blocked" | "skipped" | "conflict_unresolved";
  reason: string;
  findings: Finding[];
  gates: Record<string, boolean>;
}

interface ListedPr {
  number: number;
  title: string;
  isDraft: boolean;
  author: { login: string };
  headRefName: string;
  mergeable: string;
}

const QUALITY_GATES: Record<string, string[]> = {
  install: ["bun", "install", "--frozen-lockfile"],
  lint: ["bun", "run", "lint"],
  typecheck: ["bun", "run", "typecheck"],
  test: ["bun", "run", "test"],
  schemas: ["bun", "run", "schemas:check"],
};

async function run(command: string[]): Promise<{ ok: boolean; output: string }> {
  const [head, ...rest] = command;
  if (!head) return { ok: false, output: "empty command" };
  try {
    const result = await $`${head} ${rest}`.quiet().nothrow();
    return {
      ok: result.exitCode === 0,
      output: `${result.stdout.toString()}${result.stderr.toString()}`.slice(-4000),
    };
  } catch (error) {
    return { ok: false, output: String(error) };
  }
}

export async function listOpenPullRequests(): Promise<ListedPr[]> {
  const result =
    await $`gh pr list --state open --json number,title,isDraft,author,headRefName,mergeable --limit 50`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) return [];
  return JSON.parse(result.stdout.toString()) as ListedPr[];
}

async function changedFiles(number: number): Promise<string[]> {
  const result = await $`gh pr view ${number} --json files`.quiet().nothrow();
  if (result.exitCode !== 0) return [];
  const parsed = JSON.parse(result.stdout.toString()) as { files: { path: string }[] };
  return parsed.files.map((file) => file.path);
}

async function unifiedDiff(number: number): Promise<string> {
  const result = await $`gh pr diff ${number}`.quiet().nothrow();
  return result.exitCode === 0 ? result.stdout.toString() : "";
}

/**
 * Bring the checked out head up to date with main, in detached HEAD.
 *
 * Detached throughout on purpose. Checking the branch out by name fails
 * whenever it is checked out in another worktree, which is normal here, and
 * nothing in this path needs a branch name: the merge happens on the commit,
 * and the result is pushed back with an explicit refspec.
 *
 * The only conflict resolved automatically is bun.lock, because it is generated
 * and regenerating it is deterministic. Every other conflict is a decision about
 * intent, and a machine guessing at intent in a merge is how changes get
 * silently reverted.
 */
const NEWLINE = String.fromCharCode(10);

async function bringUpToDate(): Promise<{ ok: boolean; detail: string; changed: boolean }> {
  await run(["git", "fetch", "origin", "main"]);

  const behind = await run(["git", "rev-list", "--count", "HEAD..origin/main"]);
  if (behind.output.trim() === "0") {
    return { ok: true, detail: "already up to date with main", changed: false };
  }

  const merge = await run(["git", "merge", "origin/main", "--no-edit"]);
  if (merge.ok) return { ok: true, detail: "merged origin/main cleanly", changed: true };

  const status = await run(["git", "diff", "--name-only", "--diff-filter=U"]);
  const conflicted = status.output.trim().split(NEWLINE).filter(Boolean);
  const onlyLockfile = conflicted.length > 0 && conflicted.every((file) => file === "bun.lock");

  if (!onlyLockfile) {
    await run(["git", "merge", "--abort"]);
    return {
      ok: false,
      changed: false,
      detail:
        conflicted.length > 0
          ? `Conflicts a machine should not resolve: ${conflicted.join(", ")}`
          : "Merge failed for a reason other than file conflicts",
    };
  }

  await run(["git", "checkout", "--theirs", "bun.lock"]);
  const install = await run(["bun", "install"]);
  if (!install.ok) {
    await run(["git", "merge", "--abort"]);
    return { ok: false, detail: "Regenerating bun.lock failed", changed: false };
  }
  await run(["git", "add", "bun.lock"]);
  const commit = await run(["git", "commit", "--no-edit"]);
  return commit.ok
    ? { ok: true, detail: "resolved a bun.lock conflict by regenerating it", changed: true }
    : { ok: false, detail: "Could not commit the regenerated lockfile", changed: false };
}

function renderComment(result: GateResult): string {
  const lines: string[] = ["## Gatekeeper audit", ""];

  const gateRows = Object.entries(result.gates)
    .map(([name, ok]) => `| ${name} | ${ok ? "pass" : "fail"} |`)
    .join("\n");
  lines.push("| Gate | Result |", "|---|---|", gateRows, "");

  if (result.findings.length === 0) {
    lines.push("No audit findings.", "");
  } else {
    lines.push("| Severity | Check | Where | Detail |", "|---|---|---|---|");
    for (const finding of result.findings) {
      const where = finding.file ? `${finding.file}:${finding.line ?? ""}` : "repository";
      lines.push(`| ${finding.severity} | \`${finding.code}\` | ${where} | ${finding.message} |`);
    }
    lines.push("");
  }

  lines.push(`**Outcome:** ${result.outcome}. ${result.reason}`);
  return lines.join("\n");
}

export async function gatePullRequest(pr: ListedPr, options: GateOptions): Promise<GateResult> {
  const files = await changedFiles(pr.number);
  const facts: PullRequestFacts = {
    number: pr.number,
    author: pr.author.login,
    isDraft: pr.isDraft,
    files,
  };

  const base: Omit<GateResult, "outcome" | "reason"> = {
    number: pr.number,
    title: pr.title,
    author: pr.author.login,
    findings: [],
    gates: {},
  };

  const decision = decide(facts);
  if (!decision.merge && decision.reason === "draft") {
    return { ...base, outcome: "skipped", reason: decision.detail };
  }

  // Detached on purpose. A named checkout fails when the same branch is checked
  // out in another worktree, which is normal here: parallel agents each hold
  // one. Testing a pull request only needs its tree, not its branch name.
  const checkout = await run(["git", "fetch", "origin", `pull/${pr.number}/head`, "--force"]);
  const detach = await run(["git", "checkout", "--detach", "--force", "FETCH_HEAD"]);
  if (!checkout.ok || !detach.ok) {
    return {
      ...base,
      outcome: "blocked",
      reason: `Could not check the head out. ${detach.output.slice(-200)}`,
    };
  }
  await run(["git", "clean", "-fd"]);

  // Always test the merge result, never the branch as it stands. A branch cut
  // before a fix landed on main can pass on its own base and fail once merged,
  // which is the exact failure a gate exists to catch.
  const updated = await bringUpToDate();
  const conflictNote = ` Base: ${updated.detail}.`;
  if (!updated.ok) {
    return { ...base, outcome: "conflict_unresolved", reason: updated.detail };
  }
  // Push back only when the merge produced a commit, and by refspec so the
  // branch never has to be checked out.
  if (!options.dryRun && updated.changed) {
    await run(["git", "push", "origin", `HEAD:refs/heads/${pr.headRefName}`]);
  }

  const gates: Record<string, boolean> = {};
  for (const [name, command] of Object.entries(QUALITY_GATES)) {
    const outcome = await run(command);
    gates[name] = outcome.ok;
    if (!outcome.ok) break;
  }

  const findings = auditDiff(await unifiedDiff(pr.number), files);
  const failedGate = Object.entries(gates).find(([, ok]) => !ok)?.[0];
  const blocking = blockers(findings);

  let result: GateResult;
  if (failedGate) {
    result = {
      ...base,
      gates,
      findings,
      outcome: "blocked",
      reason: `The ${failedGate} gate failed.${conflictNote}`,
    };
  } else if (blocking.length > 0) {
    result = {
      ...base,
      gates,
      findings,
      outcome: "blocked",
      reason: `${blocking.length} blocking audit finding(s).${conflictNote}`,
    };
  } else if (!decision.merge) {
    result = { ...base, gates, findings, outcome: "blocked", reason: decision.detail };
  } else {
    result = {
      ...base,
      gates,
      findings,
      outcome: "merged",
      reason: `All gates passed.${conflictNote}`,
    };
  }

  if (!options.dryRun) {
    await run(["gh", "pr", "comment", String(pr.number), "--body", renderComment(result)]);
    if (result.outcome === "merged") {
      // No --delete-branch: it tries to switch off the merged branch and fails
      // in a detached worktree, after the merge has already happened, which
      // reads back as a failed merge. Delete the remote ref separately instead.
      const merged = await run(["gh", "pr", "merge", String(pr.number), "--squash"]);
      if (!merged.ok) {
        return { ...result, outcome: "blocked", reason: "Merge command failed." };
      }
      await run(["git", "push", "origin", "--delete", pr.headRefName]);
    }
  }

  return result;
}

export async function gateAll(options: GateOptions): Promise<GateResult[]> {
  const open = await listOpenPullRequests();
  const selected = options.only ? open.filter((pr) => pr.number === options.only) : open;
  const results: GateResult[] = [];

  // Sequential on purpose. Each pull request is checked out into the same
  // working tree, and merging one changes the base every later one is tested
  // against, which is the point.
  for (const pr of selected) {
    results.push(await gatePullRequest(pr, options));
  }

  await run(["git", "checkout", "main"]);
  await run(["git", "pull", "--ff-only"]);
  return results;
}
