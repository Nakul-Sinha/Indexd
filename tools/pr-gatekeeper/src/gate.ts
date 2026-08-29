import { $ } from "bun";
import { auditDiff, blockers, type Finding } from "./checks.ts";
import { type CiStatus, summariseChecks } from "./ci.ts";
import { decide, type PullRequestFacts } from "./policy.ts";

/**
 * The gatekeeper run loop.
 *
 * For each open pull request: audit its diff, read its continuous integration
 * result, then merge or comment. Only a conflicting pull request is checked out
 * at all, and only so the conflict can be resolved and pushed back.
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
  outcome: "merged" | "blocked" | "skipped" | "waiting" | "conflict_unresolved";
  reason: string;
  findings: Finding[];
  ci: CiStatus | null;
}

interface ListedPr {
  number: number;
  title: string;
  isDraft: boolean;
  author: { login: string };
  headRefName: string;
  mergeable: string;
}

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
 * gh pr checks exits non zero whenever anything is failing or pending, so the
 * exit code carries nothing the payload does not. Parse the payload.
 */
async function ciStatus(number: number): Promise<CiStatus> {
  const result = await $`gh pr checks ${number} --json name,bucket`.quiet().nothrow();
  const text = result.stdout.toString().trim();
  if (!text) return summariseChecks([]);
  try {
    return summariseChecks(JSON.parse(text));
  } catch {
    return { state: "none", detail: "could not read check results" };
  }
}

/**
 * Resolve a conflict against main and push the result back.
 *
 * The only conflict resolved automatically is bun.lock, because it is generated
 * and regenerating it is deterministic. Every other conflict is a decision about
 * intent, and a machine guessing at intent in a merge is how changes get
 * silently reverted.
 *
 * Detached throughout, and pushed by refspec: checking the branch out by name
 * fails whenever another worktree holds it, which is normal with parallel
 * agents.
 */
async function resolveConflict(
  number: number,
  branch: string,
  dryRun: boolean,
): Promise<{ ok: boolean; detail: string }> {
  await run(["git", "fetch", "origin", "main", `pull/${number}/head`, "--force"]);
  const detach = await run(["git", "checkout", "--detach", "--force", "FETCH_HEAD"]);
  if (!detach.ok) return { ok: false, detail: "could not check the head out" };
  await run(["git", "clean", "-fd"]);

  const merge = await run(["git", "merge", "origin/main", "--no-edit"]);
  if (merge.ok) {
    if (!dryRun) await run(["git", "push", "origin", `HEAD:refs/heads/${branch}`]);
    return { ok: true, detail: "merged main cleanly" };
  }

  const status = await run(["git", "diff", "--name-only", "--diff-filter=U"]);
  const conflicted = status.output.trim().split(/\r?\n/).filter(Boolean);
  const onlyLockfile = conflicted.length > 0 && conflicted.every((file) => file === "bun.lock");

  if (!onlyLockfile) {
    await run(["git", "merge", "--abort"]);
    return {
      ok: false,
      detail:
        conflicted.length > 0
          ? `conflicts a machine should not resolve: ${conflicted.join(", ")}`
          : "merge failed for a reason other than file conflicts",
    };
  }

  await run(["git", "checkout", "--theirs", "bun.lock"]);
  const install = await run(["bun", "install"]);
  if (!install.ok) {
    await run(["git", "merge", "--abort"]);
    return { ok: false, detail: "regenerating bun.lock failed" };
  }
  await run(["git", "add", "bun.lock"]);
  const commit = await run(["git", "commit", "--no-edit"]);
  if (!commit.ok) return { ok: false, detail: "could not commit the regenerated lockfile" };

  if (!dryRun) await run(["git", "push", "origin", `HEAD:refs/heads/${branch}`]);
  return { ok: true, detail: "resolved a bun.lock conflict by regenerating it" };
}

function renderComment(result: GateResult): string {
  const lines: string[] = ["## Gatekeeper audit", ""];

  lines.push(
    `**Checks:** ${result.ci ? `${result.ci.state}, ${result.ci.detail}` : "not read"}`,
    "",
  );

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

  const base = {
    number: pr.number,
    title: pr.title,
    author: pr.author.login,
    findings: [] as Finding[],
    ci: null as CiStatus | null,
  };

  const decision = decide(facts);
  if (!decision.merge && decision.reason === "draft") {
    return { ...base, outcome: "skipped", reason: decision.detail };
  }

  let conflictNote = "";
  if (pr.mergeable === "CONFLICTING") {
    const resolved = await resolveConflict(pr.number, pr.headRefName, options.dryRun);
    if (!resolved.ok) {
      return { ...base, outcome: "conflict_unresolved", reason: resolved.detail };
    }
    conflictNote = ` Conflict: ${resolved.detail}.`;
  }

  const findings = auditDiff(await unifiedDiff(pr.number), files);
  const blocking = blockers(findings);
  const ci = await ciStatus(pr.number);
  const withContext = { ...base, findings, ci };

  let result: GateResult;
  if (blocking.length > 0) {
    // Audit findings are reported even while checks are still running. They are
    // what a person has to act on, and waiting to say so wastes their time.
    result = {
      ...withContext,
      outcome: "blocked",
      reason: `${blocking.length} blocking audit finding(s).${conflictNote}`,
    };
  } else if (ci.state === "pending") {
    result = { ...withContext, outcome: "waiting", reason: `Checks are ${ci.detail}.` };
  } else if (ci.state === "failing") {
    result = { ...withContext, outcome: "blocked", reason: `Checks ${ci.detail}.${conflictNote}` };
  } else if (ci.state === "none") {
    result = {
      ...withContext,
      outcome: "blocked",
      reason: `No checks ran, so nothing verifies this.${conflictNote}`,
    };
  } else if (!decision.merge) {
    result = { ...withContext, outcome: "blocked", reason: decision.detail };
  } else {
    result = {
      ...withContext,
      outcome: "merged",
      reason: `Checks passed and the audit is clean.${conflictNote}`,
    };
  }

  // A pull request whose checks are still running gets no comment, because it
  // will be gated again in a few minutes and a comment per cycle is noise.
  if (!options.dryRun && result.outcome !== "waiting") {
    await run(["gh", "pr", "comment", String(pr.number), "--body", renderComment(result)]);
    if (result.outcome === "merged") {
      // No --delete-branch: it tries to switch off the merged branch and fails
      // in a detached worktree, after the merge has already happened.
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

  // Sequential on purpose. Merging one changes the base every later one is
  // measured against, which is the point.
  for (const pr of selected) {
    results.push(await gatePullRequest(pr, options));
  }

  return results;
}
