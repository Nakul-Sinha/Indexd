import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { app } from "../../../tools/mock-api/src/app.ts";
import { HttpApiClient } from "../src/api-client.ts";
import type { Caller } from "../src/caller.ts";
import { createToolInvoker, type ToolInvoker } from "../src/dispatch.ts";
import { type RecordingToolLogger, recordingToolLogger } from "../src/logging.ts";
import { InMemoryRateLimiter, type RateLimiter, unlimited } from "../src/rate-limit.ts";

/**
 * Shared test rig.
 *
 * The mock API runs in process: `app.handle` is the fetch implementation, so the
 * whole tool surface is exercised against a real HTTP request and response cycle
 * with no port bound and no server to tear down.
 */

/** The mock owns srv_7f2 as usr_demo and srv_a19 as usr_other. */
export const OWNER = "usr_demo";
export const OTHER = "usr_other";
export const OWNED_SERVER = "srv_7f2";
export const OTHER_SERVER = "srv_a19";
export const SEEDED_VERSION = 3;

export const mockFetch = (request: Request) => app.handle(request);

export function callerFor(principal: string): Caller {
  return { principal, token: "flk_testmachinetoken", transport: "stdio" };
}

export interface Rig {
  invoker: ToolInvoker;
  logger: RecordingToolLogger;
  caller: Caller;
}

export function rigFor(principal: string = OWNER, limiter: RateLimiter = unlimited): Rig {
  const logger = recordingToolLogger();
  const caller = callerFor(principal);
  const invoker = createToolInvoker({
    caller,
    logger,
    limiter,
    api: new HttpApiClient({
      baseUrl: "http://mock",
      fetch: mockFetch,
      // The mock has no token store, so it takes the principal from a header.
      principalHeader: "x-mock-principal",
    }),
  });
  return { invoker, logger, caller };
}

export function draftLimitedRig(limit: number, principal: string = OWNER): Rig {
  return rigFor(principal, new InMemoryRateLimiter({ limit, windowSeconds: 3600 }));
}

/** Pull the JSON payload back out of an MCP tool result. */
export function bodyOf(result: { content: unknown[] }): Record<string, unknown> {
  const first = result.content[0] as { type: string; text: string } | undefined;
  if (first?.type !== "text") throw new Error("tool result had no text content");
  return JSON.parse(first.text) as Record<string, unknown>;
}

/** Call the mock API directly, for arranging state and for byte comparisons. */
export async function callMock(
  path: string,
  init: RequestInit = {},
  principal: string = OWNER,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.handle(
    new Request(`http://mock${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-mock-principal": principal,
        ...(init.headers ?? {}),
      },
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

export async function currentDigest(): Promise<string> {
  const { body } = await callMock(`/v1/servers/${OWNED_SERVER}/rule-sets`);
  const items = body.items as Array<{ content_digest: string }>;
  const last = items.at(-1);
  if (!last) throw new Error("the mock has no seeded rule versions");
  return last.content_digest;
}

export async function mintApproval(
  overrides: Record<string, unknown> = {},
  principal: string = OWNER,
): Promise<string> {
  const { body } = await callMock(
    "/v1/approvals",
    {
      method: "POST",
      body: JSON.stringify({
        server_id: OWNED_SERVER,
        rule_set_version: SEEDED_VERSION,
        content_digest: await currentDigest(),
        ...overrides,
      }),
    },
    principal,
  );
  return body.token as string;
}

const here = dirname(fileURLToPath(import.meta.url));
const contractsSchemaDir = join(here, "..", "..", "..", "packages", "contracts", "schemas");

export function readContractSchemas(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(contractsSchemaDir, "index.json"), "utf8"));
}

export function readToolManifest(): Array<{
  name: string;
  class: string;
  description: string;
  inputSchema: unknown;
}> {
  return JSON.parse(readFileSync(join(contractsSchemaDir, "mcp-tools.json"), "utf8"));
}

const validator = new AjvJsonSchemaValidator();

/** Check a value against a contract type, using the schema the repo commits. */
export function matchesContract(typeName: string, value: unknown): true | string {
  const schemas = readContractSchemas();
  const schema = schemas[typeName];
  if (!schema) return `no committed schema named ${typeName}`;
  const check = validator.getValidator<unknown>(schema as never)(value);
  return check.valid ? true : (check.errorMessage ?? "invalid");
}
