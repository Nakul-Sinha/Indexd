import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HttpApiClient } from "../src/api-client.ts";
import { createHttpHandler } from "../src/http.ts";
import { recordingToolLogger } from "../src/logging.ts";
import { unlimited } from "../src/rate-limit.ts";
import { createFarlandsMcpServer, SERVER_NAME } from "../src/server.ts";
import { callerFor, mockFetch, OWNED_SERVER, OWNER, SEEDED_VERSION } from "./support.ts";

/**
 * Both transports, driving the same tool implementations.
 *
 * stdio is exercised over the SDK's in-memory transport pair, which is the same
 * protocol path with the pipe removed. Streamable HTTP is exercised by handing
 * the client transport the handler's own fetch, so a full session runs through
 * real Request and Response objects with no port bound.
 */

const MACHINE_TOKEN = "flk_testmachinetoken";

function apiClient() {
  return new HttpApiClient({
    baseUrl: "http://mock",
    fetch: mockFetch,
    principalHeader: "x-mock-principal",
  });
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((entry) => entry.text ?? "").join("");
}

describe("the stdio path", () => {
  const logger = recordingToolLogger();
  const server = createFarlandsMcpServer({
    caller: callerFor(OWNER),
    api: apiClient(),
    limiter: unlimited,
    logger,
  });
  const client = new Client({ name: "stdio-test-client", version: "0.0.0" });

  test("lists the generated tool surface", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(13);
    expect(tools.map((tool) => tool.name)).toContain("deploy_rules");

    const getServer = tools.find((tool) => tool.name === "get_server");
    expect(getServer?.inputSchema.required).toEqual(["server_id"]);
    expect(getServer?.annotations?.readOnlyHint).toBe(true);
  });

  test("a read runs end to end over the protocol", async () => {
    const result = await client.callTool({
      name: "get_server",
      arguments: { server_id: OWNED_SERVER },
    });

    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain(OWNED_SERVER);
  });

  test("a refusal comes back as content, not as a protocol error", async () => {
    const result = await client.callTool({
      name: "deploy_rules",
      arguments: { server_id: OWNED_SERVER, version: SEEDED_VERSION },
    });

    // The call resolved. Nothing threw, so no agent framework has a stack trace
    // to render in place of the sentence a human needs to read.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("approval_required");
    expect(textOf(result)).toContain("Ask the server owner");
  });

  test("the transport carried a log line for every call", () => {
    expect(logger.entries.length).toBeGreaterThanOrEqual(2);
    expect(logger.entries.every((entry) => entry.event === "mcp_tool_call")).toBe(true);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });
});

describe("the Streamable HTTP path", () => {
  const handler = createHttpHandler({
    api: apiClient(),
    limiter: unlimited,
    logger: recordingToolLogger(),
    // The mock has no token store, so the development target is told which
    // principal the token stands for.
    resolvePrincipal: () => OWNER,
  });
  const fetchThroughHandler = (url: string | URL, init?: RequestInit) =>
    handler.fetch(new Request(url.toString(), init));

  test("refuses a request with no machine token", async () => {
    const response = await handler.fetch(
      new Request("http://mcp.test/mcp", { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("unauthorized");
  });

  test("refuses a token that is not a machine token", async () => {
    const response = await handler.fetch(
      new Request("http://mcp.test/mcp", {
        method: "POST",
        headers: { authorization: "Bearer apv_an_approval_token" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(401);
  });

  test("serves nothing outside its endpoint", async () => {
    const response = await handler.fetch(
      new Request("http://mcp.test/", {
        method: "POST",
        headers: { authorization: `Bearer ${MACHINE_TOKEN}` },
      }),
    );

    expect(response.status).toBe(404);
  });

  test("rejects an unknown session id", async () => {
    const response = await handler.fetch(
      new Request("http://mcp.test/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${MACHINE_TOKEN}`,
          "mcp-session-id": "00000000-0000-0000-0000-000000000000",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(404);
  });

  test("runs a whole session for an authenticated agent", async () => {
    const client = new Client({ name: "http-test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
      fetch: fetchThroughHandler,
      requestInit: { headers: { authorization: `Bearer ${MACHINE_TOKEN}` } },
    });

    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect(handler.sessionCount).toBe(1);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(13);

    const refusal = await client.callTool({
      name: "deploy_rules",
      arguments: { server_id: OWNED_SERVER, version: SEEDED_VERSION },
    });
    expect(refusal.isError).toBe(true);
    expect(textOf(refusal)).toContain("approval_required");

    await client.close();
  });

  test("a session belongs to the token that opened it", async () => {
    const client = new Client({ name: "http-pinning-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
      fetch: fetchThroughHandler,
      requestInit: { headers: { authorization: `Bearer ${MACHINE_TOKEN}` } },
    });
    await client.connect(transport);

    const stolen = await handler.fetch(
      new Request("http://mcp.test/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer flk_someone_elses_token",
          "mcp-session-id": transport.sessionId ?? "",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

    expect(stolen.status).toBe(403);
    await client.close();
  });

  afterAll(async () => {
    await handler.close();
  });
});
