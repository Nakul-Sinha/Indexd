import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The grep-level check ENGINEER-1.md section 13 asks for: the package contains
 * no generation of plugin source, no persistence, and no path from a candidate
 * to a caller that does not go through the validator.
 *
 * These are source-level assertions because that is the level the claim is made
 * at. Comments are stripped first: a sentence about a bypass is not a bypass,
 * and a check that cannot tell the difference would be satisfied by renaming
 * things.
 */

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * Good enough for this package, which has no regex literals and no string
 * containing a comment marker. It is not a parser and does not need to be.
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

describe("the package emits documents, never code", () => {
  test("there is no source generation for the plugin runtime", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(filesMatching(/\bjava\b/i)).toEqual([]);
    expect(filesMatching(/\bpublic\s+(?:static|class)\b/)).toEqual([]);
    expect(filesMatching(/\.jar\b/)).toEqual([]);
  });
});

describe("the validator is the only path in", () => {
  test("it is called from exactly one place", () => {
    const callers = filesMatching(/validateRuleDocument\(/);
    expect(callers).toEqual(["pipeline.ts"]);

    const pipeline = files.find((file) => file.name === "pipeline.ts");
    expect(pipeline?.code.match(/validateRuleDocument\(/g)?.length).toBe(1);
  });

  test("the module that exports authorRules is the module that calls it", () => {
    expect(filesMatching(/export async function authorRules\b/)).toEqual(["pipeline.ts"]);
  });

  test("nothing casts an unchecked value to a rule document", () => {
    expect(filesMatching(/\bas\s+(?:provisionalVocabulary\.)?RuleDocument\b/)).toEqual([]);
  });

  test("there is no trusted-caller flag by any name", () => {
    expect(filesMatching(/\b(?:bypass|trusted|skipValidation|unsafe|allowInvalid)\b/i)).toEqual([]);
  });
});

describe("the package has no side effect but the model call", () => {
  test("nothing writes to disk", () => {
    expect(filesMatching(/\bnode:fs\b|\bwriteFile\b|\bmkdir\b/)).toEqual([]);
  });

  test("nothing reaches the network on its own", () => {
    expect(filesMatching(/\bfetch\(|\bnode:https?\b|\bXMLHttpRequest\b/)).toEqual([]);
  });

  test("nothing persists a rule version", () => {
    expect(filesMatching(/\bdrizzle\b|\bpostgres\b|\bpg-boss\b|\bS3Client\b|\bPutObject/i)).toEqual(
      [],
    );
  });

  test("the provider is constructed in one file, so the Bedrock switch stays local", () => {
    expect(filesMatching(/@anthropic-ai\/sdk/)).toEqual(["anthropic.ts"]);
    expect(filesMatching(/new Anthropic\(/)).toEqual(["anthropic.ts"]);
  });

  test("no credential is read out of the environment here", () => {
    expect(filesMatching(/process\.env|ANTHROPIC_API_KEY/)).toEqual([]);
  });
});
