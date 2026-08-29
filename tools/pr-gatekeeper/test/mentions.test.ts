import { describe, expect, test } from "bun:test";
import { AUDIT_MARKER, type Comment, mentionsAssistant, scanForRequests } from "../src/mentions.ts";

const at = (createdAt: string, body: string, author = "someone"): Comment => ({
  author,
  createdAt,
  body,
});

describe("mentionsAssistant", () => {
  test("matches a plain mention", () => {
    expect(mentionsAssistant("@claude please take another look")).toBe(true);
    expect(mentionsAssistant("hey @Claude, re-review?")).toBe(true);
  });

  test("does not match a longer word or an address", () => {
    expect(mentionsAssistant("claudette said no")).toBe(false);
    expect(mentionsAssistant("mail me at me@claude.example")).toBe(false);
    expect(mentionsAssistant("see docs/@claudex")).toBe(false);
  });

  test("ignores a mention inside a code fence", () => {
    // A pull request quoting a config file that contains the string is not
    // asking for a review.
    expect(mentionsAssistant("```\nowner = @claude\n```")).toBe(false);
    expect(mentionsAssistant("inline `@claude` sample")).toBe(false);
  });

  test("still matches prose alongside a fenced block", () => {
    expect(mentionsAssistant("```\ncode\n```\n@claude thoughts?")).toBe(true);
  });
});

describe("scanForRequests", () => {
  const audit = at("2026-08-29T15:43:00Z", `## ${AUDIT_MARKER}\n\nconfidence 2/5`, "Nakul-Sinha");

  test("a mention after the last audit is pending", () => {
    const scan = scanForRequests([audit, at("2026-08-29T16:00:00Z", "@claude re-review please")]);
    expect(scan.pending).toHaveLength(1);
    expect(scan.lastAuditAt).toBe("2026-08-29T15:43:00Z");
  });

  test("a mention before the last audit is already answered", () => {
    const scan = scanForRequests([at("2026-08-29T15:00:00Z", "@claude look at this"), audit]);
    expect(scan.pending).toHaveLength(0);
  });

  test("with no audit yet, any mention is pending", () => {
    const scan = scanForRequests([at("2026-08-29T15:00:00Z", "@claude first look")]);
    expect(scan.pending).toHaveLength(1);
    expect(scan.lastAuditAt).toBeNull();
  });

  test("comments without a mention never trigger", () => {
    const scan = scanForRequests([audit, at("2026-08-29T16:00:00Z", "fixed the token default")]);
    expect(scan.pending).toHaveLength(0);
  });

  test("an audit is never treated as a request, even if it quotes a mention", () => {
    const quoting = at(
      "2026-08-29T17:00:00Z",
      `## ${AUDIT_MARKER}\n\nasked by @claude`,
      "Nakul-Sinha",
    );
    expect(scanForRequests([quoting]).pending).toHaveLength(0);
  });

  test("several unanswered mentions all come back", () => {
    const scan = scanForRequests([
      audit,
      at("2026-08-29T16:00:00Z", "@claude one"),
      at("2026-08-29T16:05:00Z", "@claude two"),
    ]);
    expect(scan.pending).toHaveLength(2);
  });
});
