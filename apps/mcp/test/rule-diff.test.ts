import { describe, expect, test } from "bun:test";
import type { ApiClient } from "../src/api-client.ts";
import { createToolInvoker } from "../src/dispatch.ts";
import { recordingToolLogger } from "../src/logging.ts";
import { unlimited } from "../src/rate-limit.ts";
import { describeRule, diffRuleDocuments } from "../src/rule-diff.ts";
import { bodyOf, callerFor, OWNED_SERVER, OWNER, rigFor, SEEDED_VERSION } from "./support.ts";

/**
 * The semantic diff reads as sentences.
 *
 * A diff nobody can read is a gate nobody uses, so the assertion is not that the
 * diff is correct JSON, it is that a person glancing at it learns what changed.
 */

const before = {
  schema_version: 1,
  rules: [
    {
      rule: "mob_spawn_rate",
      id: "hostiles_near_spawn",
      mob: "zombie",
      region: "spawn",
      multiplier: 0.5,
    },
    { rule: "gamerule", id: "keep_it", name: "keep_inventory", value: false },
  ],
};

const after = {
  schema_version: 1,
  rules: [
    {
      rule: "mob_spawn_rate",
      id: "hostiles_near_spawn",
      mob: "zombie",
      region: "spawn",
      multiplier: 1.4,
    },
    { rule: "damage_modifier", id: "softer_hits", target: "player", multiplier: 0.75 },
  ],
};

describe("rules are described in words", () => {
  test("a spawn rate reads as a subject and a value", () => {
    expect(describeRule(before.rules[0] ?? {})).toEqual({
      subject: "zombie spawns in spawn",
      value: "0.5x",
    });
  });

  test("a gamerule names the gamerule", () => {
    expect(describeRule(before.rules[1] ?? {}).subject).toBe("gamerule keep_inventory");
  });

  test("a drop table lists what drops and how often", () => {
    const described = describeRule({
      rule: "block_drop",
      id: "stone_gives_iron",
      block: "stone",
      region: "mining_world",
      drops: [{ item: "iron_ingot", count: 2, chance: 0.25 }],
    });

    expect(described.subject).toBe("stone drops in mining_world");
    expect(described.value).toBe("2x iron_ingot at 25%");
  });

  test("an unrecognised rule kind is still shown rather than dropped", () => {
    const described = describeRule({ rule: "not_in_the_vocabulary", id: "mystery", weird: true });
    expect(described.subject).toContain("not_in_the_vocabulary");
    expect(described.value).toContain("weird");
  });
});

describe("the diff", () => {
  test("renders a change as a sentence with both sides", () => {
    const entries = diffRuleDocuments(before, after);
    const changed = entries.find((entry) => entry.rule_id === "hostiles_near_spawn");

    expect(changed?.kind).toBe("changed");
    expect(changed?.summary).toBe("zombie spawns in spawn: 0.5x -> 1.4x");
    expect(changed?.before).toBe("0.5x");
    expect(changed?.after).toBe("1.4x");
  });

  test("reports additions and removals", () => {
    const entries = diffRuleDocuments(before, after);
    const kinds = new Map(entries.map((entry) => [entry.rule_id, entry.kind]));

    expect(kinds.get("softer_hits")).toBe("added");
    expect(kinds.get("keep_it")).toBe("removed");
  });

  test("is never a JSON patch", () => {
    for (const entry of diffRuleDocuments(before, after)) {
      expect(entry.summary).not.toContain('"op"');
      expect(entry.summary).not.toContain("/rules/");
    }
  });

  test("says nothing about rules that did not move", () => {
    expect(diffRuleDocuments(before, before)).toEqual([]);
  });
});

describe("diff_rule_sets", () => {
  function apiWithVersions(): ApiClient {
    return {
      async send() {
        return {
          status: 200,
          ok: true,
          body: {
            items: [
              { version: 3, document: before, content_digest: "sha256:aaa" },
              { version: 4, document: after, content_digest: "sha256:bbb" },
            ],
            next_cursor: null,
          },
        };
      },
    };
  }

  test("returns readable entries for two versions the caller can see", async () => {
    const invoker = createToolInvoker({
      caller: callerFor(OWNER),
      api: apiWithVersions(),
      limiter: unlimited,
      logger: recordingToolLogger(),
    });

    const body = bodyOf(
      await invoker.call("diff_rule_sets", {
        server_id: OWNED_SERVER,
        from_version: 3,
        to_version: 4,
      }),
    );
    const diff = body.diff as { entries: Array<{ summary: string }> };

    expect(body.basis).toBe("documents");
    expect(diff.entries.map((entry) => entry.summary)).toContain(
      "zombie spawns in spawn: 0.5x -> 1.4x",
    );
  });

  test("refuses a version the caller cannot see rather than diffing nothing", async () => {
    const { invoker } = rigFor();
    const body = bodyOf(
      await invoker.call("diff_rule_sets", {
        server_id: OWNED_SERVER,
        from_version: SEEDED_VERSION,
        to_version: 99,
      }),
    );

    expect(body.error).toBe("not_found");
    expect(String(body.resource)).toContain("99");
  });

  test("admits when it only had digests to compare", async () => {
    const invoker = createToolInvoker({
      caller: callerFor(OWNER),
      limiter: unlimited,
      logger: recordingToolLogger(),
      api: {
        async send() {
          return {
            status: 200,
            ok: true,
            body: {
              items: [
                { version: 3, json_url: "s3://a", content_digest: "sha256:aaa" },
                { version: 4, json_url: "s3://b", content_digest: "sha256:bbb" },
              ],
            },
          };
        },
      },
    });

    const body = bodyOf(
      await invoker.call("diff_rule_sets", {
        server_id: OWNED_SERVER,
        from_version: 3,
        to_version: 4,
      }),
    );

    expect(body.basis).toBe("digests_only");
    expect(body.digest_changed).toBe(true);
    expect(String(body.note)).toContain("not inline");
  });
});
