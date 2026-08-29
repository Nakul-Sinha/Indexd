import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type BuildRuleJarResult = {
  jarUrl: string;
  contentDigest: string;
};

const STATIC_JAR = resolve(import.meta.dir, "../../fixtures/rules/static-rule.jar");
const STATIC_JSON = resolve(import.meta.dir, "../../fixtures/rules/static-rule.json");

/**
 * Stub until Engineer 3 wires the real pipeline. Returns the committed
 * fixture JAR and a digest recomputed from disk — never from caller input.
 */
export async function buildRuleJar(ruleJson: unknown): Promise<BuildRuleJarResult> {
  const payload = existsSync(STATIC_JAR)
    ? readFileSync(STATIC_JAR)
    : Buffer.from(JSON.stringify(ruleJson ?? readStaticRule()), "utf8");
  const contentDigest = createHash("sha256").update(payload).digest("hex");
  return {
    jarUrl: existsSync(STATIC_JAR) ? `file://${STATIC_JAR}` : "fixture://static-rule.json",
    contentDigest,
  };
}

export function readStaticRule(): unknown {
  if (!existsSync(STATIC_JSON)) {
    return { name: "static-fixture", rules: [] };
  }
  return JSON.parse(readFileSync(STATIC_JSON, "utf8")) as unknown;
}
