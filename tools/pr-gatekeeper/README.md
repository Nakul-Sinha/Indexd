# pr-gatekeeper

Watches open pull requests, audits them, runs the full quality gate, and merges what passes.

## Running it

Always from the dedicated worktree, never from a tree with uncommitted work: it checks pull
request heads out into whatever tree it runs in.

```bash
git worktree add --detach G:/Devjams-raincloud/pr-gatekeeper main
cd G:/Devjams-raincloud/pr-gatekeeper
bun run tools/pr-gatekeeper/src/index.ts --dry-run
```

| Flag | Effect |
|---|---|
| `--dry-run` | Report what would happen. No merge, no comment, no push. |
| `--only N` | Gate one pull request. |

## Running it continuously

`run-gate.ps1` is the durable path. Register it with Task Scheduler on a ten minute repetition and
it keeps working across reboots, with no editor session involved. The setup command is in the
comment at the top of the script, and every run appends to `gate.log`.

## What happens per pull request

1. Fetch `pull/N/head` and check it out detached. Detached throughout, because a named checkout
   fails whenever another worktree holds that branch, which is normal with parallel agents.
2. Merge `origin/main`. It always tests the merge result rather than the branch as it stands: a
   branch cut before a fix landed can pass on its own base and fail once merged.
3. Run `install`, `lint`, `typecheck`, `test`, `schemas:check`.
4. Audit the diff.
5. Comment the result. Merge only if every gate passed and policy allows it.

## What it will not merge

The default is refusal. It audits and comments on everything; it merges very little.

| Refusal | Why |
|---|---|
| Untrusted author | A green build proves code runs, not that it should land. Merging strangers on a passing build merges whatever a stranger can make build. |
| `packages/contracts` | Four clients and a schema generator read it, so a change there changes all of them at once. |
| `packages/db` | The migration sequence has one owner. Parallel migrations are the cheapest integration failure to prevent. |
| `.github/workflows` | A pull request that edits CI can make its own checks pass. |
| `tools/pr-gatekeeper` | Same, one level up. It cannot merge changes to itself. |
| `infra/` | Cloud resources and money. |
| Unresolved conflict | See below. |

Trusted authors are listed in `src/policy.ts`.

## Conflict resolution is deliberately narrow

The only conflict it resolves is `bun.lock`, because it is generated and regenerating it is
deterministic. Everything else aborts the merge and reports which files conflicted. A machine
guessing at intent in a conflict is how changes get silently reverted.

Resolved conflicts are pushed back by refspec, so the branch is never checked out.

## The audit

| Check | Severity | Rule it enforces |
|---|---|---|
| `em_dash` | block | House style |
| `authorship_note` | block | No assistant trailers in the tree |
| `java_generation` | block | The model emits validated JSON, never Java |
| `raw_event_storage` | block | Raw world events grow without bound and nothing reads them |
| `validation_bypass` | block | The validator is the only path from a rule document to a build |
| `auto_approval` | block | Any auto-approving rule class is one a player can reach through injection |
| `vocabulary_widened` | warn | Widening the action space is a reviewed security change |
| `no_tests` | warn | Source landed without tests |

Only added lines are audited, comments are stripped before matching, and test files are exempt
from the identifier checks. A test asserting a bypass is absent has to name the bypass.

A false positive that blocks a good pull request is worse than a missing check, because a gate
people learn to override is not a gate.

## Untrusted input

The title, body, branch name and diff are written by whoever opened the pull request. Nothing here
interprets any of them as instructions: the audit matches patterns against text, and no command is
ever built from pull request content.
