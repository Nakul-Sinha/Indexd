import { describe, expect, test } from "bun:test";
import {
  type DeploymentState,
  isAbortable,
  isPreCutover,
  isTerminal,
  PRE_CUTOVER_STATES,
} from "../src/deployment.ts";
import { DRAFT_RATE_LIMIT, requiresApproval, TOOLS_BY_CLASS } from "../src/mcp-tools.ts";
import {
  approvalRequired,
  clusterApprovalRequired,
  isRefusal,
  notFound,
  rateLimited,
} from "../src/refusal.ts";

describe("the invariant, encoded", () => {
  test("cutover and everything after it is not pre-cutover", () => {
    // Pod A stays authoritative through every pre-cutover state, so an abort
    // there costs a deleted candidate and nothing else. Once cutover starts,
    // that is no longer true, and this list is the single definition of where
    // the line sits.
    expect(isPreCutover("verifying")).toBe(true);
    expect(isPreCutover("cutover")).toBe(false);
    expect(isPreCutover("draining")).toBe(false);
    expect(isPreCutover("idle")).toBe(false);
  });

  test("abort is safe exactly through verifying and is a no-op afterwards", () => {
    for (const state of PRE_CUTOVER_STATES) {
      expect(isAbortable(state)).toBe(true);
    }
    for (const state of ["cutover", "draining", "idle", "aborted", "failed"] as const) {
      expect(isAbortable(state)).toBe(false);
    }
  });

  test("terminal states are terminal", () => {
    expect(isTerminal("idle")).toBe(true);
    expect(isTerminal("aborted")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("presync")).toBe(false);
  });

  test("every state is classified, so a new state cannot be forgotten", () => {
    const all: DeploymentState[] = [
      "queued",
      "building",
      "staging",
      "presync",
      "freezing",
      "verifying",
      "cutover",
      "draining",
      "idle",
      "aborted",
      "failed",
    ];
    for (const state of all) {
      const classified =
        isPreCutover(state) || isTerminal(state) || state === "cutover" || state === "draining";
      expect(classified).toBe(true);
    }
  });
});

describe("the structured refusal", () => {
  const base = {
    tool: "deploy_rules",
    server_id: "srv_7f2",
    rule_set_version: 4,
    content_digest: `sha256:${"9".repeat(64)}`,
  };

  test("is a value, not an exception", () => {
    const refusal = approvalRequired({ reason: "missing", ...base });
    expect(isRefusal(refusal)).toBe(true);
    expect(refusal.error).toBe("approval_required");
  });

  test("names the missing approval and the exact content it applies to", () => {
    const refusal = approvalRequired({ reason: "missing", ...base });
    expect(refusal.message).toContain("v4");
    expect(refusal.message).toContain("srv_7f2");
    expect(refusal.content_digest).toBe(base.content_digest);
  });

  test("tells the caller to ask a human rather than to retry", () => {
    const refusal = approvalRequired({ reason: "missing", ...base });
    expect(refusal.resolution).toContain("owner");
    expect(refusal.resolution).toContain("will return this same refusal");
  });

  test("is byte identical for the same inputs, so every surface agrees", () => {
    const a = approvalRequired({ reason: "digest_mismatch", ...base });
    const b = approvalRequired({ reason: "digest_mismatch", ...base });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("distinguishes every approval failure mode", () => {
    const reasons = [
      "missing",
      "expired",
      "consumed",
      "principal_mismatch",
      "digest_mismatch",
    ] as const;
    const messages = new Set(
      reasons.map((reason) => approvalRequired({ reason, ...base }).message),
    );
    expect(messages.size).toBe(reasons.length);
  });
});

describe("tool classes", () => {
  test("every act tool requires an approval token", () => {
    for (const name of TOOLS_BY_CLASS.act) {
      expect(requiresApproval(name)).toBe(true);
    }
  });

  test("no read or draft tool requires approval", () => {
    for (const name of [...TOOLS_BY_CLASS.read, ...TOOLS_BY_CLASS.draft]) {
      expect(requiresApproval(name)).toBe(false);
    }
  });

  test("the act class is exactly the four tools that touch a live world", () => {
    expect([...TOOLS_BY_CLASS.act].sort()).toEqual([
      "create_server",
      "deploy_rules",
      "power_action",
      "rollback",
    ]);
  });

  test("draft tools carry a rate limit, because they cost model tokens", () => {
    expect(TOOLS_BY_CLASS.draft.length).toBeGreaterThan(0);
    expect(DRAFT_RATE_LIMIT.calls).toBeGreaterThan(0);
    expect(DRAFT_RATE_LIMIT.window_seconds).toBeGreaterThan(0);
  });
});

describe("refusal constructors", () => {
  test("notFound produces the same shape everywhere it is used", () => {
    const a = notFound({ tool: "get_server", resource: "server srv_a19" });
    const b = notFound({ tool: "get_server", resource: "server srv_a19" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.error).toBe("not_found");
    // Scoped reads are refused rather than returned empty, because an empty
    // result and a forbidden one are distinguishable and that leaks existence.
    expect(a.resolution).toContain("servers you own");
  });

  test("rateLimited is distinguishable from an approval refusal", () => {
    const limited = rateLimited({
      tool: "author_rules",
      server_id: "srv_7f2",
      limit: 10,
      window_seconds: 3600,
      retry_after_seconds: 42,
    });
    expect(limited.error).toBe("rate_limited");
    // The correct next move differs: wait, rather than ask a human.
    expect(limited.resolution).toContain("no human action is needed");
    expect(limited.resolution).not.toContain("owner");
  });

  test("clusterApprovalRequired covers create_server, which has no server yet", () => {
    const refusal = clusterApprovalRequired({
      reason: "missing",
      tool: "create_server",
      server_id: null,
      operation: "create_server",
    });
    expect(refusal.error).toBe("approval_required");
    expect(refusal.server_id).toBeNull();
    expect(refusal.message).not.toContain("null");
  });

  test("a cluster refusal says the operation is not undone by rollback", () => {
    const refusal = clusterApprovalRequired({
      reason: "missing",
      tool: "power_action",
      server_id: "srv_7f2",
      operation: "stop",
    });
    expect(refusal.message).toContain("srv_7f2");
    expect(refusal.resolution).toContain("not undone by a rule rollback");
  });

  test("every refusal constructor produces something isRefusal accepts", () => {
    expect(isRefusal(notFound({ tool: "t", resource: "r" }))).toBe(true);
    expect(
      isRefusal(
        rateLimited({
          tool: "t",
          server_id: "srv_7f2",
          limit: 1,
          window_seconds: 1,
          retry_after_seconds: 1,
        }),
      ),
    ).toBe(true);
    expect(
      isRefusal(
        clusterApprovalRequired({
          reason: "expired",
          tool: "t",
          server_id: null,
          operation: "create_server",
        }),
      ),
    ).toBe(true);
  });
});
