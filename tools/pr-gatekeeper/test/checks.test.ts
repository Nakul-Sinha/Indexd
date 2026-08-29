import { describe, expect, test } from "bun:test";
import {
  addedLines,
  auditDiff,
  blockers,
  checkAuthorshipNotes,
  checkEmDashes,
  checkInvariants,
  checkTestsAccompanySource,
} from "../src/checks.ts";
import { summariseChecks } from "../src/ci.ts";
import { decide } from "../src/policy.ts";

const diff = (body: string) =>
  `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n${body}`;

describe("addedLines", () => {
  test("captures added lines with their file and line number", () => {
    const parsed = addedLines(diff(" context\n+added one\n+added two"));
    expect(parsed).toEqual([
      { file: "x.ts", line: 2, text: "added one" },
      { file: "x.ts", line: 3, text: "added two" },
    ]);
  });

  test("ignores removed lines, so deleting a violation is never blocked", () => {
    const parsed = addedLines(diff("-const autoApprove = true;"));
    expect(parsed).toHaveLength(0);
  });

  test("tracks the file across a multi file diff", () => {
    const multi = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,0 +1,1 @@",
      "+first",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -5,0 +5,1 @@",
      "+second",
    ].join("\n");
    const parsed = addedLines(multi);
    expect(parsed.map((entry) => entry.file)).toEqual(["a.ts", "b.ts"]);
    expect(parsed[1]?.line).toBe(5);
  });
});

describe("style checks", () => {
  test("blocks an em dash in an added line", () => {
    const findings = checkEmDashes(addedLines(diff("+a sentence — with a dash")));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("block");
  });

  test("allows hyphens and en dashes", () => {
    expect(checkEmDashes(addedLines(diff("+well-formed and 1–2 range")))).toHaveLength(0);
  });

  test("blocks authorship trailers and generated-by notes", () => {
    expect(checkAuthorshipNotes(addedLines(diff("+Co-Authored-By: Someone")))).toHaveLength(1);
    expect(
      checkAuthorshipNotes(addedLines(diff("+Generated with [Claude Code](https://x)"))),
    ).toHaveLength(1);
  });

  test("does not fire on ordinary prose", () => {
    expect(
      checkAuthorshipNotes(addedLines(diff("+the generated schema is committed"))),
    ).toHaveLength(0);
  });
});

describe("invariant checks", () => {
  const at = (file: string, text: string) => [{ file, line: 1, text }];

  test("blocks Java generation in the authoring package", () => {
    const findings = checkInvariants(
      at("packages/authoring/src/emit.ts", "return `public void onEnable() {}`;"),
    );
    expect(findings.map((f) => f.code)).toContain("java_generation");
  });

  test("does not fire on authoring tests", () => {
    const findings = checkInvariants(
      at("packages/authoring/test/emit.test.ts", 'expect(out).not.toContain("public void");'),
    );
    expect(findings).toHaveLength(0);
  });

  test("blocks raw world event persistence", () => {
    const findings = checkInvariants(
      at("apps/api/src/modules/telemetry/store.ts", "await db.insert(raw_events).values(rows);"),
    );
    expect(findings.map((f) => f.code)).toContain("raw_event_storage");
  });

  test("blocks a validation bypass anywhere in the tree", () => {
    const findings = checkInvariants(at("apps/mcp/src/tools.ts", "if (trustedOutput) return doc;"));
    expect(findings.map((f) => f.code)).toContain("validation_bypass");
  });

  test("blocks an auto-approval path", () => {
    const findings = checkInvariants(
      at("apps/api/src/approvals.ts", "const autoApprove = tier === 'safe';"),
    );
    expect(findings.map((f) => f.code)).toContain("auto_approval");
  });

  test("does not fire on the word class, because TypeScript has classes", () => {
    // Regression: this blocked the authoring pull request three times.
    expect(
      checkInvariants(
        at("packages/authoring/src/pipeline.ts", "export class AuthoringFailedError {"),
      ),
    ).toHaveLength(0);
  });

  test("does not fire on a comment that names what it forbids", () => {
    // A file documenting why there is no bypass must not be blocked for saying so.
    expect(
      checkInvariants(
        at("packages/authoring/src/pipeline.ts", "// The model emits JSON, never a Java class."),
      ),
    ).toHaveLength(0);
    expect(
      checkInvariants(
        at("apps/api/src/x.ts", " * There is no skipValidation flag and never will be."),
      ),
    ).toHaveLength(0);
  });

  test("does not fire inside a test that asserts the absence of a bypass", () => {
    // Regression: this blocked packages/authoring/test/no-bypass.test.ts.
    expect(
      checkInvariants(
        at(
          "packages/authoring/test/no-bypass.test.ts",
          'expect(src).not.toContain("skipValidation");',
        ),
      ),
    ).toHaveLength(0);
  });

  test("still catches real Java", () => {
    expect(
      checkInvariants(
        at("packages/authoring/src/emit.ts", "const t = `public void onEnable() {}`;"),
      ),
    ).toHaveLength(1);
    expect(
      checkInvariants(
        at("packages/authoring/src/emit.ts", 'lines.push("import org.bukkit.Bukkit;");'),
      ),
    ).toHaveLength(1);
  });

  test("clean code produces no findings", () => {
    expect(
      checkInvariants(at("apps/cli/src/watch.ts", "const budget = STALL_BUDGET_MS[state];")),
    ).toHaveLength(0);
  });
});

describe("tests accompany source", () => {
  test("warns when source lands with no tests", () => {
    const findings = checkTestsAccompanySource(["apps/cli/src/watch.ts"]);
    expect(findings[0]?.severity).toBe("warn");
  });

  test("is satisfied by a test file", () => {
    expect(
      checkTestsAccompanySource(["apps/cli/src/watch.ts", "apps/cli/test/watch.test.ts"]),
    ).toHaveLength(0);
  });

  test("does not demand tests for a fixtures-only change", () => {
    expect(checkTestsAccompanySource(["fixtures/rules/valid/07-new.json"])).toHaveLength(0);
  });
});

describe("merge policy", () => {
  const base = { number: 1, author: "Nakul-Sinha", isDraft: false, files: ["apps/cli/src/a.ts"] };

  test("merges a trusted author's ordinary change", () => {
    expect(decide(base).merge).toBe(true);
  });

  test("never merges a draft", () => {
    const decision = decide({ ...base, isDraft: true });
    expect(decision.merge).toBe(false);
  });

  test("never merges an untrusted author, however green the build", () => {
    const decision = decide({ ...base, author: "drive-by" });
    expect(decision.merge).toBe(false);
    if (!decision.merge) expect(decision.reason).toBe("untrusted_author");
  });

  test("never merges a contracts change, because four clients read it", () => {
    const decision = decide({ ...base, files: ["packages/contracts/src/api.ts"] });
    expect(decision.merge).toBe(false);
    if (!decision.merge) expect(decision.reason).toBe("human_required_path");
  });

  test("never merges a migration, a CI change, or an infra change", () => {
    for (const file of [
      "packages/db/migrations/0006_x.sql",
      ".github/workflows/ci.yml",
      "infra/tofu/main.tf",
    ]) {
      expect(decide({ ...base, files: [file] }).merge).toBe(false);
    }
  });

  test("never merges a change to the gatekeeper itself", () => {
    // A pull request that edits the gate could make its own checks pass.
    expect(decide({ ...base, files: ["tools/pr-gatekeeper/src/policy.ts"] }).merge).toBe(false);
  });

  test("generated schema output does not count as a contracts change", () => {
    const decision = decide({
      ...base,
      files: ["apps/mcp/src/tools.ts", "packages/contracts/schemas/mcp-tools.json"],
    });
    expect(decision.merge).toBe(true);
  });
});

describe("auditDiff", () => {
  test("collects findings across every check and separates blockers", () => {
    const findings = auditDiff(diff("+a — b\n+Co-Authored-By: X"), ["apps/cli/src/a.ts"]);
    const codes = findings.map((f) => f.code);
    expect(codes).toContain("em_dash");
    expect(codes).toContain("authorship_note");
    expect(codes).toContain("no_tests");
    // no_tests is a warning and must not block on its own.
    expect(blockers(findings).map((f) => f.code)).not.toContain("no_tests");
  });

  test("a clean diff with tests produces nothing", () => {
    expect(
      auditDiff(diff("+const x = 1;"), ["apps/cli/src/a.ts", "apps/cli/test/a.test.ts"]),
    ).toHaveLength(0);
  });
});

describe("continuous integration status", () => {
  test("no checks is not the same as passing", () => {
    // A pull request nothing verified must not merge on the strength of an
    // empty check list.
    expect(summariseChecks([]).state).toBe("none");
  });

  test("all passing reports passing", () => {
    const status = summariseChecks([
      { name: "TypeScript", bucket: "pass" },
      { name: "Fixtures", bucket: "pass" },
    ]);
    expect(status.state).toBe("passing");
    expect(status.detail).toContain("2 checks");
  });

  test("anything failing outranks anything pending", () => {
    // Otherwise a pull request with one failed job and one still running waits
    // forever on the job that cannot change the answer.
    const status = summariseChecks([
      { name: "TypeScript", bucket: "fail" },
      { name: "Fixtures", bucket: "pending" },
    ]);
    expect(status.state).toBe("failing");
    expect(status.detail).toContain("TypeScript");
  });

  test("pending while nothing has failed reports pending", () => {
    const status = summariseChecks([
      { name: "TypeScript", bucket: "pass" },
      { name: "Fixtures", bucket: "pending" },
    ]);
    expect(status.state).toBe("pending");
    expect(status.detail).toContain("Fixtures");
  });

  test("a waiting bucket counts as pending", () => {
    expect(summariseChecks([{ name: "Deploy", bucket: "waiting" }]).state).toBe("pending");
  });

  test("skipped checks do not block a merge", () => {
    const status = summariseChecks([
      { name: "TypeScript", bucket: "pass" },
      { name: "Optional", bucket: "skipping" },
    ]);
    expect(status.state).toBe("passing");
  });
});
