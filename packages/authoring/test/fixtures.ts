import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { provisionalVocabulary } from "@farlands/contracts";
import type { RuleModel, RuleModelRequest } from "../src/index.ts";

/**
 * Shared test scaffolding: the fixture set every Stage B track develops
 * against, and the scripted model that stands in for the provider.
 *
 * No test in this package reaches the network. The fake is the whole reason
 * that is possible, and it is also the only way to script a model that fails
 * three times in a row on purpose.
 */

const rulesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
  "rules",
);

export const serverContext = JSON.parse(
  await readFile(join(rulesRoot, "context.json"), "utf8"),
) as provisionalVocabulary.ServerRuleContext;

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export interface Fixture {
  readonly name: string;
  readonly document: unknown;
}

async function loadDirectory(kind: "valid" | "invalid"): Promise<Fixture[]> {
  const names = (await readdir(join(rulesRoot, kind))).filter(
    (name) => name !== "expectations.json",
  );
  return Promise.all(
    names.map(async (name) => ({ name, document: await loadJson(join(rulesRoot, kind, name)) })),
  );
}

export const validFixtures = await loadDirectory("valid");
export const invalidFixtures = await loadDirectory("invalid");

export const invalidExpectations = (await loadJson(
  join(rulesRoot, "invalid", "expectations.json"),
)) as Record<string, string[]>;

export interface ScriptedModel {
  readonly model: RuleModel;
  /** Every request the loop made, in order, so a test can inspect what was fed back. */
  readonly calls: RuleModelRequest[];
}

/**
 * A model that answers from a script and then refuses to be called again.
 *
 * Running off the end throws rather than repeating the last answer, so a test
 * that expects three attempts fails loudly if the loop makes a fourth.
 */
export function scriptedModel(responses: readonly unknown[]): ScriptedModel {
  const calls: RuleModelRequest[] = [];
  let index = 0;

  return {
    calls,
    model: {
      async generate(request: RuleModelRequest): Promise<unknown> {
        calls.push(request);
        if (index >= responses.length) {
          throw new Error(
            `The scripted model was called ${index + 1} times but has ${responses.length} answers.`,
          );
        }
        const response = responses[index];
        index += 1;
        return response;
      },
    },
  };
}

/** The same answer for every attempt the loop is allowed to make. */
export function repeated(document: unknown, times: number): unknown[] {
  return Array.from({ length: times }, () => structuredClone(document));
}
