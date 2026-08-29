/**
 * Serialize the contract types to JSON Schema.
 *
 * TypeBox types are JSON Schema at runtime, so this is a serialization rather
 * than a translation. That is the entire reason TypeBox won the slot: the MCP
 * tool schemas are the contract types, not a hand-maintained copy of them.
 *
 *   bun run schemas          write schemas/
 *   bun run schemas:check    fail if the committed output is stale
 *
 * CI runs the check. A drifted schema fails the build rather than shipping an
 * MCP surface that disagrees with the API it calls.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthorRulesFailure,
  AuthorRulesRequest,
  AuthorRulesResponse,
  DeployRequest,
  DeployResponse,
  MintApprovalRequest,
  MintApprovalResponse,
  PreviewDeployResponse,
  ServerSummary,
} from "../src/api.ts";
import { Deployment, DeploymentState, DeploymentStateEvent } from "../src/deployment.ts";
import { SseEvent } from "../src/events.ts";
import { TOOL_DEFINITIONS, toolInputs } from "../src/mcp-tools.ts";
import { Experiment, Proposal } from "../src/proposals.ts";
import {
  ApprovalRequiredRefusal,
  ClusterApprovalRequiredRefusal,
  NotFoundRefusal,
  RateLimitedRefusal,
} from "../src/refusal.ts";
import { RuleDiff, RuleSet, RuleSetVersion } from "../src/rules.ts";
import { RollupMetrics, TelemetryBatch, WorldEvent, WorldEventsRollup } from "../src/telemetry.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "schemas");

const types = {
  Deployment,
  DeploymentState,
  DeploymentStateEvent,
  SseEvent,
  ApprovalRequiredRefusal,
  ClusterApprovalRequiredRefusal,
  RateLimitedRefusal,
  NotFoundRefusal,
  RuleSet,
  RuleSetVersion,
  RuleDiff,
  WorldEvent,
  TelemetryBatch,
  RollupMetrics,
  WorldEventsRollup,
  Proposal,
  Experiment,
  ServerSummary,
  AuthorRulesRequest,
  AuthorRulesResponse,
  AuthorRulesFailure,
  PreviewDeployResponse,
  DeployRequest,
  DeployResponse,
  MintApprovalRequest,
  MintApprovalResponse,
};

/** The MCP tool manifest: name, class, description, and input schema. */
function toolManifest() {
  return TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    class: tool.class,
    description: tool.description,
    inputSchema: toolInputs[tool.name],
  }));
}

function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const files: Record<string, string> = {
  "index.json": stableStringify(types),
  "mcp-tools.json": stableStringify(toolManifest()),
};

const check = process.argv.includes("--check");

if (check) {
  let stale = false;
  for (const [name, expected] of Object.entries(files)) {
    let actual: string;
    try {
      actual = await readFile(join(outDir, name), "utf8");
    } catch {
      console.error(`schemas/${name} is missing. Run: bun run schemas`);
      stale = true;
      continue;
    }
    if (actual !== expected) {
      console.error(`schemas/${name} is out of date. Run: bun run schemas`);
      stale = true;
    }
  }
  if (stale) process.exit(1);
  console.log(`schemas up to date (${Object.keys(files).length} files)`);
} else {
  await mkdir(outDir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(outDir, name), contents, "utf8");
  }
  console.log(`wrote ${Object.keys(files).length} schema files to schemas/`);
}
