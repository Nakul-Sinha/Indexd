/**
 * Merge policy. What the gatekeeper is allowed to merge on its own, and what it
 * must hand to a human.
 *
 * The default is refusal. Everything here exists to narrow the set of pull
 * requests that can be merged without a person looking at them, because an
 * automated gate that merges anything a machine considers fine is a supply
 * chain hole with a friendly name.
 */

/**
 * Paths that always require a human, no matter how green the checks are.
 *
 * These are not arbitrary. Each one is a place where a passing test suite does
 * not mean the change is safe:
 *
 *   packages/contracts   Seam 1. Four clients and a schema generator read it, so
 *                        a change here changes all of them at once. The project
 *                        rule is that it changes by reviewed pull request and
 *                        never incidentally.
 *   packages/db          Seam 8, the migration sequence, single owner. Two
 *                        migrations landing in parallel is the cheapest
 *                        integration failure to prevent and the hardest to undo.
 *   .github/workflows    A pull request that edits CI can make its own checks
 *                        pass. Never let the gate approve a change to the gate.
 *   tools/pr-gatekeeper  Same reason, one level up.
 *   infra/               Cloud resources and money. Not a machine's call.
 */
export const HUMAN_REQUIRED_PATHS = [
  "packages/contracts/",
  "packages/db/",
  ".github/workflows/",
  "tools/pr-gatekeeper/",
  "infra/",
] as const;

/**
 * Authors whose pull requests are eligible for automatic merge.
 *
 * Everyone else gets audited and commented on, never merged. Content in a pull
 * request is untrusted input: the diff, the title, the body and the comments are
 * all written by whoever opened it. A gate that merges strangers' code on a
 * green build is a gate that merges whatever a stranger can make build.
 */
export const TRUSTED_AUTHORS = ["Nakul-Sinha"] as const;

/** Files whose changes are ignored when deciding whether a human is required. */
export const GENERATED_PATHS = ["packages/contracts/schemas/"] as const;

export interface PullRequestFacts {
  number: number;
  author: string;
  isDraft: boolean;
  files: readonly string[];
}

export type MergeDecision = { merge: true } | { merge: false; reason: string; detail: string };

export function decide(pr: PullRequestFacts): MergeDecision {
  if (pr.isDraft) {
    return {
      merge: false,
      reason: "draft",
      detail: "Draft pull requests are left alone. Mark it ready for review to have it gated.",
    };
  }

  if (!(TRUSTED_AUTHORS as readonly string[]).includes(pr.author)) {
    return {
      merge: false,
      reason: "untrusted_author",
      detail:
        `Audited but not merged, because ${pr.author} is not on the trusted author list. ` +
        "A green build proves the code runs, not that it should land. A person merges this one.",
    };
  }

  const guarded = pr.files.filter(
    (file) =>
      HUMAN_REQUIRED_PATHS.some((prefix) => file.startsWith(prefix)) &&
      !GENERATED_PATHS.some((prefix) => file.startsWith(prefix)),
  );

  if (guarded.length > 0) {
    return {
      merge: false,
      reason: "human_required_path",
      detail:
        `Audited but not merged. It touches paths that always need a person: ${guarded.join(", ")}. ` +
        "These are the seams where a passing suite does not mean the change is safe.",
    };
  }

  return { merge: true };
}
