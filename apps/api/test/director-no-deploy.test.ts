import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorldEventsRollup } from "@farlands/contracts";
import type { PendingProposalInput, ProposalVerdict } from "../src/modules/director/index.ts";
import { Director, InMemoryProposalStore } from "../src/modules/director/index.ts";
import {
  brief,
  scriptedProposalModel,
  scriptedRuleModel,
  serverContext,
  VALID_DOCUMENT,
} from "./director-support.ts";

/**
 * The Director cannot create a deployment.
 *
 * Two proofs, because behaviour alone is the weaker one. A behavioural test says
 * this loop did not deploy on this input; the source-level test says there is no
 * input on which it could, because there is no import and no call path to reach
 * a deployment with. ENGINEER-1.md section 13 asks for the second one by name.
 */

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "modules", "director");

/**
 * Good enough for this module, which has no regex literal and no string
 * containing a comment marker. It is not a parser and does not need to be. The
 * stripping matters: a comment explaining why the Director never deploys is not
 * a deployment, and a check that could not tell the difference would be
 * satisfied by deleting the explanation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

const files = await Promise.all(
  (await readdir(srcRoot))
    .filter((name) => name.endsWith(".ts"))
    .map(async (name) => ({
      name,
      code: stripComments(await readFile(join(srcRoot, name), "utf8")),
    })),
);

function filesMatching(pattern: RegExp): string[] {
  return files.filter((file) => pattern.test(file.code)).map((file) => file.name);
}

function fileNamed(name: string): string {
  const found = files.find((file) => file.name === name)?.code;
  if (found === undefined) throw new Error(`${name} is missing from the module.`);
  return found;
}

/** Every module specifier this module pulls in, static or dynamic. */
function importSpecifiers(): string[] {
  const found = new Set<string>();
  for (const file of files) {
    for (const match of file.code.matchAll(/from\s*["']([^"']+)["']/g)) {
      if (match[1] !== undefined) found.add(match[1]);
    }
    for (const match of file.code.matchAll(
      /(?:^|[^.\w])(?:import|require)\s*\(?\s*["']([^"']+)["']/g,
    )) {
      if (match[1] !== undefined) found.add(match[1]);
    }
  }
  return [...found].sort();
}

/** Everything the module is allowed to reach. Anything else is a new seam to review. */
const ALLOWED_IMPORTS = [
  "@farlands/authoring",
  "../telemetry/index.ts",
  "./brief.ts",
  "./director.ts",
  "./model.ts",
  "./prompt.ts",
  "./rate-limit.ts",
  "./store.ts",
  "@farlands/contracts",
].sort();

describe("there is no import path to a deployment", () => {
  test("the module has source to inspect", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.map((file) => file.name).sort()).toEqual([
      "brief.ts",
      "director.ts",
      "index.ts",
      "model.ts",
      "prompt.ts",
      "rate-limit.ts",
      "store.ts",
    ]);
  });

  test("its imports are exactly the reviewed set", () => {
    expect(importSpecifiers()).toEqual(ALLOWED_IMPORTS);
  });

  test("nothing named deploy is imported, and nothing is imported dynamically", () => {
    expect(filesMatching(/from\s*["'][^"']*(?:deploy|approval|kubernetes|k8s)/i)).toEqual([]);
    // A dynamic import would make the list above incomplete, so it is refused
    // outright rather than pattern-matched.
    expect(filesMatching(/\bimport\s*\(/)).toEqual([]);
  });

  test("the word does not appear in the code at all, only in comments about it", () => {
    expect(filesMatching(/\bdeploy/i)).toEqual([]);
    expect(filesMatching(/\brollback|\brestore\b/i)).toEqual([]);
  });

  test("there is nothing to reach an endpoint with", () => {
    expect(
      filesMatching(/\bfetch\s*\(|\bnew\s+Request\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/),
    ).toEqual([]);
    expect(filesMatching(/\bnode:https?\b|\bundici\b|\baxios\b/)).toEqual([]);
  });

  test("the module serves no route, so it cannot be an endpoint either", () => {
    expect(filesMatching(/\bElysia\b|\.(?:post|put|patch|delete)\s*\(/)).toEqual([]);
  });

  test("nothing calls an operation that changes a live world", () => {
    // mintId is excluded by naming the thing that matters: an approval token.
    // A proposal id is not a capability and minting one grants nothing.
    expect(
      filesMatching(
        /\b(?:deploy|approve|rollback|restore|cutover|mintApproval|mintToken)[A-Za-z_]*\s*\(/i,
      ),
    ).toEqual([]);
  });
});

describe("the only write is a pending row", () => {
  test("the loop touches the proposal store through three methods and one of them writes", () => {
    const director = fileNamed("director.ts");
    const used = new Set(
      [...director.matchAll(/this\.proposals\.(\w+)\s*\(/g)].map((match) => match[1]),
    );
    expect([...used].sort()).toEqual(["insertPending", "latest", "recentRejections"]);
    expect(director.match(/insertPending\s*\(/g)?.length).toBe(1);
  });

  test("the loop never records a verdict and never names one", () => {
    const director = fileNamed("director.ts");
    expect(/\.review\s*\(/.test(director)).toBe(false);
    expect(/["']approved["']/.test(director)).toBe(false);
    expect(/["']rejected["']/.test(director)).toBe(false);
  });

  test("pending is assigned by the store, not passed by the caller", () => {
    const store = fileNamed("store.ts");
    expect(/status:\s*"pending"/.test(store)).toBe(true);
    // PendingProposalInput has no status field for a caller to get wrong.
    const input = store.match(/interface PendingProposalInput \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(input).not.toContain("status");
    expect(input).not.toContain("reviewed");
  });
});

/**
 * A store that fails the test if the Director calls anything but its three
 * permitted methods. `review` is on the table's interface because a human uses
 * it; it is not on the handle the Director holds, and this proves the narrowing
 * is real rather than decorative.
 */
class WatchedStore extends InMemoryProposalStore {
  readonly calls: string[] = [];

  override async insertPending(input: PendingProposalInput) {
    this.calls.push("insertPending");
    return super.insertPending(input);
  }

  override async latest(serverId: string) {
    this.calls.push("latest");
    return super.latest(serverId);
  }

  override async recentRejections(serverId: string, limit: number) {
    this.calls.push("recentRejections");
    return super.recentRejections(serverId, limit);
  }

  override async review(_verdict: ProposalVerdict): Promise<never> {
    this.calls.push("review");
    throw new Error("The Director reached the review path, which is a human's write.");
  }
}

const WINDOW: WorldEventsRollup = {
  server_id: serverContext.server_id,
  window_start: "2026-08-29T18:00:00.000Z",
  window_end: "2026-08-29T18:05:00.000Z",
  metrics: {
    joins: 7,
    leaves: 7,
    deaths: 11,
    blocks_placed: 40,
    blocks_broken: 62,
    chat_messages: 18,
    unique_players: 7,
    mean_session_seconds: 2193.48,
    seconds_in_region: { spawn: 900, mining_world: 1500 },
  },
};

describe("a full run, observed from the outside", () => {
  test("it queues one pending row and does nothing else", async () => {
    const proposals = new WatchedStore({ now: () => Date.parse("2026-08-29T19:00:00.000Z") });
    const proposalModel = scriptedProposalModel([brief()]);
    const ruleModel = scriptedRuleModel([VALID_DOCUMENT]);

    const director = new Director({
      rollups: {
        async list() {
          return [WINDOW];
        },
      },
      proposals,
      model: proposalModel.model,
      ruleModel: ruleModel.model,
      now: () => Date.parse("2026-08-29T19:00:00.000Z"),
    });

    const outcome = await director.run({ context: serverContext });
    expect(outcome.status).toBe("proposed");

    expect(proposals.calls).toEqual(["latest", "recentRejections", "insertPending"]);

    const rows = Object.values(proposals.contents()).flat();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.reviewed_by).toBeNull();
    expect(rows[0]?.reviewed_at).toBeNull();
    expect(rows[0]?.rejection_reason).toBeNull();
  });

  test("the queued document came through authorRules, so the validator saw it", async () => {
    const proposals = new WatchedStore({ now: () => Date.parse("2026-08-29T19:00:00.000Z") });
    const ruleModel = scriptedRuleModel([VALID_DOCUMENT]);

    const director = new Director({
      rollups: {
        async list() {
          return [WINDOW];
        },
      },
      proposals,
      model: scriptedProposalModel([brief()]).model,
      ruleModel: ruleModel.model,
    });

    const outcome = await director.run({ context: serverContext });
    expect(outcome.status).toBe("proposed");
    // One call into the authoring seam, which is the only way a document can
    // exist here: authorRules returns nothing that validation.ts rejected.
    expect(ruleModel.calls).toHaveLength(1);
    if (outcome.status === "proposed") {
      expect(outcome.proposal.suggested_rules).toEqual(VALID_DOCUMENT);
      expect(outcome.attempts).toBe(1);
    }
  });

  test("a server with no closed windows queues nothing and costs no model call", async () => {
    const proposals = new WatchedStore();
    const proposalModel = scriptedProposalModel([]);

    const director = new Director({
      rollups: {
        async list() {
          return [];
        },
      },
      proposals,
      model: proposalModel.model,
      ruleModel: scriptedRuleModel([]).model,
    });

    expect((await director.run({ context: serverContext })).status).toBe("no_observation");
    expect(proposalModel.calls).toHaveLength(0);
    expect(Object.values(proposals.contents()).flat()).toHaveLength(0);
  });

  test("a candidate the validator rejects three times queues nothing", async () => {
    const proposals = new WatchedStore();
    const director = new Director({
      rollups: {
        async list() {
          return [WINDOW];
        },
      },
      proposals,
      model: scriptedProposalModel([brief()]).model,
      // A region the server does not have: shape-valid, semantically refused.
      ruleModel: scriptedRuleModel([
        { schema_version: 1, rules: [{ ...VALID_DOCUMENT.rules[0], region: "atlantis" }] },
        { schema_version: 1, rules: [{ ...VALID_DOCUMENT.rules[0], region: "atlantis" }] },
        { schema_version: 1, rules: [{ ...VALID_DOCUMENT.rules[0], region: "atlantis" }] },
      ]).model,
    });

    const outcome = await director.run({ context: serverContext });
    expect(outcome.status).toBe("authoring_failed");
    expect(Object.values(proposals.contents()).flat()).toHaveLength(0);
    expect(proposals.calls).not.toContain("insertPending");
  });
});
