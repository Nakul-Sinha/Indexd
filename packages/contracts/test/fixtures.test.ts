import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerRuleContext } from "../src/rule-document.provisional.ts";
import { validateRuleDocument } from "../src/validation.provisional.ts";

/**
 * The fixture contract.
 *
 * Every Stage B track develops against these files: the authoring repair loop,
 * the MCP and CLI happy paths, and the mock API all read them. If a fixture stops
 * behaving the way this test asserts, four workstreams are quietly wrong, so the
 * assertion lives here rather than in each of them.
 */

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures");
const rulesRoot = join(fixturesRoot, "rules");

const context = JSON.parse(
  await readFile(join(rulesRoot, "context.json"), "utf8"),
) as ServerRuleContext;

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("valid rule fixtures", () => {
  test("there is at least one fixture per rule kind", async () => {
    const names = await readdir(join(rulesRoot, "valid"));
    const documents = await Promise.all(
      names.map((name) => loadJson(join(rulesRoot, "valid", name))),
    );
    const kinds = new Set<string>();
    for (const document of documents) {
      for (const rule of (document as { rules: { rule: string }[] }).rules) {
        kinds.add(rule.rule);
      }
    }
    expect([...kinds].sort()).toEqual([
      "block_drop",
      "damage_modifier",
      "entity_drop",
      "gamerule",
      "mob_spawn_rate",
    ]);
  });

  test("every valid fixture passes an unmodified validator", async () => {
    const names = await readdir(join(rulesRoot, "valid"));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const document = await loadJson(join(rulesRoot, "valid", name));
      const result = validateRuleDocument(document, context);
      if (!result.ok) {
        throw new Error(`${name} should validate but failed: ${JSON.stringify(result.errors)}`);
      }
      expect(result.ok).toBe(true);
    }
  });
});

describe("invalid rule fixtures", () => {
  test("each one fails with the error code it is meant to demonstrate", async () => {
    const expectations = (await loadJson(
      join(rulesRoot, "invalid", "expectations.json"),
    )) as Record<string, string[]>;

    for (const [name, expectedCodes] of Object.entries(expectations)) {
      const document = await loadJson(join(rulesRoot, "invalid", name));
      const result = validateRuleDocument(document, context);

      if (result.ok) throw new Error(`${name} should have failed validation but passed`);

      const codes = new Set(result.errors.map((error) => error.code));
      for (const expected of expectedCodes) {
        expect(codes).toContain(expected);
      }
    }
  });

  test("every invalid fixture is covered by expectations", async () => {
    const names = (await readdir(join(rulesRoot, "invalid"))).filter(
      (name) => name !== "expectations.json",
    );
    const expectations = (await loadJson(
      join(rulesRoot, "invalid", "expectations.json"),
    )) as Record<string, string[]>;
    expect([...names].sort()).toEqual(Object.keys(expectations).sort());
  });

  test("errors carry repair guidance a model can act on", async () => {
    const document = await loadJson(join(rulesRoot, "invalid", "unknown-region.json"));
    const result = validateRuleDocument(document, context);

    if (result.ok) throw new Error("expected failure");
    const error = result.errors[0];
    expect(error).toBeDefined();
    expect(error?.hint).toBeDefined();
    // The hint names the regions that do exist, which is what turns a failure
    // into a usable repair instruction instead of a dead end.
    expect(error?.hint).toContain("spawn");
  });

  test("a document with no regions defined gets a different hint", () => {
    const emptyContext: ServerRuleContext = { server_id: "srv_new", regions: [] };
    const result = validateRuleDocument(
      {
        schema_version: 1,
        rules: [
          {
            rule: "mob_spawn_rate",
            id: "calmer_spawn",
            mob: "zombie",
            region: "spawn",
            multiplier: 1,
          },
        ],
      },
      emptyContext,
    );

    if (result.ok) throw new Error("expected failure");
    expect(result.errors[0]?.hint).toContain("no regions defined");
  });
});

describe("the validator has no bypass", () => {
  test("shape failures are reported before semantic ones, so repair input is usable", async () => {
    const document = await loadJson(join(rulesRoot, "invalid", "shape-missing-id.json"));
    const result = validateRuleDocument(document, context);

    if (result.ok) throw new Error("expected failure");
    expect(result.errors.every((error) => error.code === "shape")).toBe(true);
  });

  test("an empty rules array is rejected rather than treated as a no-op change", () => {
    const result = validateRuleDocument({ schema_version: 1, rules: [] }, context);
    expect(result.ok).toBe(false);
  });

  test("unknown top level keys are rejected", () => {
    const result = validateRuleDocument(
      {
        schema_version: 1,
        rules: [{ rule: "gamerule", id: "a", name: "keep_inventory", value: true }],
        trusted: true,
      },
      context,
    );
    expect(result.ok).toBe(false);
  });
});
