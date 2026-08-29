import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createToolInvoker, type DispatcherDeps } from "./dispatch.ts";
import { generateToolSchemas } from "./schema.ts";

/**
 * The MCP server itself: the platform as an agent action space.
 *
 * This uses the SDK's low-level `Server` rather than the higher level helper on
 * purpose. The helper takes Zod schemas and derives JSON Schema from them, which
 * would put a second definition of the tool surface in this package. The
 * contract types are already JSON Schema at run time, so the low-level server
 * lets `tools/list` publish the contract itself, byte for byte, with nothing in
 * between to drift.
 */

export const SERVER_NAME = "farlands";
export const SERVER_VERSION = "0.1.0";

/**
 * Told to the agent before it calls anything. The class boundary is the security
 * boundary, so an agent that reads this should already know which calls can
 * stop, and why retrying a refusal is not the move.
 */
export const SERVER_INSTRUCTIONS = [
  "Farlands exposes a game server control plane as three classes of tool, and the class boundary is the security boundary.",
  "",
  "READ tools (list_servers, get_server, get_world_telemetry, get_deployment, list_rule_sets, get_rule_set, diff_rule_sets) are free to call and are scoped to servers this caller owns. A server you do not own is reported as not found rather than as an empty result. get_world_telemetry returns aggregated rollups and is a behavioural record of named players: treat it as personal data.",
  "",
  "DRAFT tools (author_rules, preview_deploy) change nothing live, but they invoke a model and write durable rows, so they are rate limited per caller per server. A rate_limited response means wait, not ask a human.",
  "",
  "ACT tools (deploy_rules, rollback, create_server, power_action) touch a live world and require an approval token a human minted against the exact content digest they reviewed. Without a valid token they return an approval_required refusal and change nothing. That refusal is final for this call: the correct next move is to ask the server owner for an approval, never to retry.",
].join("\n");

export function createFarlandsMcpServer(deps: DispatcherDeps): Server {
  const invoker = createToolInvoker(deps);
  const tools = generateToolSchemas();

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    // Never throws. A refusal, an unknown tool and a bug in a tool body all come
    // back as a result with content the agent can read, because a JSON-RPC error
    // is rendered as a stack trace by most agent frameworks and the refusal is
    // the thing that has to be readable.
    invoker.call(request.params.name, request.params.arguments),
  );

  return server;
}
