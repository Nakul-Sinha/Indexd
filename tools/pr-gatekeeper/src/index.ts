import { gateAll } from "./gate.ts";

/**
 * Entry point.
 *
 *   bun run tools/pr-gatekeeper/src/index.ts --dry-run
 *   bun run tools/pr-gatekeeper/src/index.ts --only 14
 *
 * Run it from the gatekeeper worktree, never from a tree with uncommitted work:
 * it checks branches out into whatever tree it is run in.
 */

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const onlyIndex = argv.indexOf("--only");
const only = onlyIndex >= 0 ? Number(argv[onlyIndex + 1]) : undefined;

const results = await gateAll({ dryRun, only });

if (results.length === 0) {
  console.log("no open pull requests");
} else {
  for (const result of results) {
    const blocking = result.findings.filter((f) => f.severity === "block").length;
    console.log(
      `#${result.number} ${result.outcome.padEnd(19)} ${result.title} (${result.author})` +
        (blocking > 0 ? ` [${blocking} blocking]` : ""),
    );
    console.log(`    ${result.reason}`);
  }
}

const unresolved = results.filter((r) => r.outcome === "conflict_unresolved").length;
process.exit(unresolved > 0 ? 2 : 0);
