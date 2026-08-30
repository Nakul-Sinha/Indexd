import {
  type ApiClient,
  type ApiRequest,
  type ApiResult,
  createToolInvoker,
  InMemoryRateLimiter,
  type RateLimiter,
  stderrToolLogger,
  type ToolLogger,
  type ToolOutcome,
  validateToolArguments,
} from "@farlands/mcp";

import type { CreateServerInput, ServerActionInput } from "../servers/model";
import { ServerService } from "../servers/service";
import {
  type AllayToolProposal,
  allayCreateServerArgumentsDto,
  allayPowerActionArgumentsDto,
  allayProposalDto,
} from "./model";

export const ALLAY_MCP_TOOL_NAMES = [
  "list_servers",
  "get_server",
  "create_server",
  "power_action",
] as const;

export type AllayMcpToolName = (typeof ALLAY_MCP_TOOL_NAMES)[number];
export type AllayMcpActToolName = AllayToolProposal["tool"];

const ALLAY_READ_TOOLS = new Set<AllayMcpToolName>(["list_servers", "get_server"]);
const ALLAY_ACT_TOOLS = new Set<AllayMcpToolName>(["create_server", "power_action"]);

// This is a local capability marker, not a user credential. It is added only
// after the authenticated /api/allay/execute boundary validates a confirmation.
const MANUAL_CONFIRMATION_MARKER = "allay_authenticated_manual_confirmation";

export interface AllayControlPlane {
  listServers(userId: string): Promise<unknown[]>;
  getServer(userId: string, serverId: string): Promise<unknown>;
  createServer(userId: string, input: CreateServerInput): Promise<string>;
  powerServer(serverId: string, userId: string, input: ServerActionInput): Promise<unknown>;
}

const liveControlPlane: AllayControlPlane = {
  listServers: (userId) => ServerService.getAllByUser(userId),
  getServer: (userId, serverId) => ServerService.getById(userId, serverId),
  createServer: (userId, input) => ServerService.create(userId, input),
  powerServer: (serverId, userId, input) => ServerService.performAction(serverId, userId, input),
};

type AllayMcpDependencies = {
  controlPlane?: AllayControlPlane;
  logger?: ToolLogger;
  limiter?: RateLimiter;
};

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function approvalRequired(tool: AllayMcpActToolName): ApiResult {
  return {
    status: 403,
    ok: false,
    body: {
      error: "approval_required",
      reason: "missing",
      tool,
      message: "This live control-plane action requires an explicit human confirmation.",
      resolution: "Show the exact action to the signed-in operator and wait for confirmation.",
    },
  };
}

function failure(cause: unknown, tool: string, resource?: string): ApiResult {
  const candidate = recordOf(cause);
  const originalStatus = typeof candidate.code === "number" ? candidate.code : 500;
  if (originalStatus === 404) {
    return {
      status: 404,
      ok: false,
      body: {
        error: "not_found",
        tool,
        resource: resource ?? "resource",
        message: `No ${resource ?? "resource"} you can see.`,
        resolution: "Check the identifier and your ownership of the server.",
      },
    };
  }

  const response = candidate.response;
  const message =
    typeof response === "string" && response.length <= 240
      ? response
      : "The live control plane could not complete the request.";

  // ACT tools interpret every 403 as an ownership refusal. Quota and policy
  // refusals from the manual control plane are conflicts instead, so preserve
  // their meaning without making them look like an out-of-scope server.
  const statusCode = originalStatus === 403 ? 409 : originalStatus;
  return {
    status: statusCode >= 400 && statusCode <= 599 ? statusCode : 500,
    ok: false,
    body: { error: "control_plane_error", tool, message },
  };
}

class AllayServerApiClient implements ApiClient {
  constructor(
    private readonly userId: string,
    private readonly confirmed: boolean,
    private readonly controlPlane: AllayControlPlane,
  ) {}

  async send(_caller: { principal: string }, request: ApiRequest): Promise<ApiResult> {
    try {
      if (request.method === "GET" && request.path === "/v1/servers") {
        const items = await this.controlPlane.listServers(this.userId);
        return { status: 200, ok: true, body: { items, next_cursor: null } };
      }

      const serverMatch = /^\/v1\/servers\/([^/]+)$/.exec(request.path);
      if (request.method === "GET" && serverMatch?.[1]) {
        const serverId = decodeURIComponent(serverMatch[1]);
        const server = await this.controlPlane.getServer(this.userId, serverId);
        return { status: 200, ok: true, body: server };
      }

      if (request.method === "POST" && request.path === "/v1/servers") {
        const body = recordOf(request.body);
        if (!this.confirmed || body.approval_token !== MANUAL_CONFIRMATION_MARKER) {
          return approvalRequired("create_server");
        }

        const { approval_token: _approvalToken, ...publicArguments } = body;
        const args = allayCreateServerArgumentsDto.parse(publicArguments);
        const gameConfigJson = {
          maxPlayers: args.max_players,
          difficulty: args.difficulty,
          pvp: args.pvp,
          ...(args.seed === undefined ? {} : { seed: args.seed }),
          ...(args.motd === undefined ? {} : { motd: args.motd }),
        };
        const serverId = await this.controlPlane.createServer(this.userId, {
          name: args.name,
          game: "minecraft",
          type: args.type,
          version: args.version,
          cpuCores: args.cpu_cores,
          ramMb: args.ram_mb,
          storageGb: args.storage_gb,
          gameConfigJson,
        });
        return {
          status: 201,
          ok: true,
          body: { server_id: serverId, name: args.name, state: "ready" },
        };
      }

      const powerMatch = /^\/v1\/servers\/([^/]+)\/power$/.exec(request.path);
      if (request.method === "POST" && powerMatch?.[1]) {
        const body = recordOf(request.body);
        if (!this.confirmed || body.approval_token !== MANUAL_CONFIRMATION_MARKER) {
          return approvalRequired("power_action");
        }

        const serverId = decodeURIComponent(powerMatch[1]);
        const args = allayPowerActionArgumentsDto.parse({
          server_id: serverId,
          action: body.action,
        });
        const result = await this.controlPlane.powerServer(serverId, this.userId, {
          action: args.action,
        });
        return { status: 200, ok: true, body: { server_id: serverId, ...recordOf(result) } };
      }

      return {
        status: 404,
        ok: false,
        body: {
          error: "unsupported_tool_route",
          message: "This MCP route is not available to Allay.",
        },
      };
    } catch (cause) {
      const powerMatch = /^\/v1\/servers\/([^/]+)\/power$/.exec(request.path);
      const serverMatch = /^\/v1\/servers\/([^/]+)$/.exec(request.path);
      const resourceId = powerMatch?.[1] ?? serverMatch?.[1];
      const tool =
        request.path === "/v1/servers"
          ? request.method === "GET"
            ? "list_servers"
            : "create_server"
          : powerMatch
            ? "power_action"
            : "get_server";
      return failure(cause, tool, resourceId ? `server ${resourceId}` : undefined);
    }
  }
}

export type AllayModelToolResult =
  | { kind: "outcome"; outcome: ToolOutcome }
  | { kind: "proposal"; proposal: AllayToolProposal };

export interface AllayMcpBridge {
  callFromModel(name: string, args: unknown): Promise<AllayModelToolResult>;
  executeConfirmed(proposal: AllayToolProposal): Promise<ToolOutcome>;
}

export function createAllayMcpBridge(
  userId: string,
  dependencies: AllayMcpDependencies = {},
): AllayMcpBridge {
  const controlPlane = dependencies.controlPlane ?? liveControlPlane;
  const logger = dependencies.logger ?? stderrToolLogger();
  const limiter = dependencies.limiter ?? new InMemoryRateLimiter();
  const caller = { principal: userId, token: null, transport: "http" as const };
  const unconfirmed = createToolInvoker({
    caller,
    api: new AllayServerApiClient(userId, false, controlPlane),
    logger,
    limiter,
  });
  const confirmed = createToolInvoker({
    caller,
    api: new AllayServerApiClient(userId, true, controlPlane),
    logger,
    limiter,
  });

  return {
    async callFromModel(name, args) {
      if (!ALLAY_MCP_TOOL_NAMES.includes(name as AllayMcpToolName)) {
        return { kind: "outcome", outcome: await unconfirmed.invoke(name, args) };
      }

      const toolName = name as AllayMcpToolName;
      const outcome = await unconfirmed.invoke(toolName, args);
      if (!ALLAY_ACT_TOOLS.has(toolName) || outcome.code !== "approval_required") {
        return { kind: "outcome", outcome };
      }

      const checked = validateToolArguments(toolName, args);
      if (!checked.ok) return { kind: "outcome", outcome };
      const normalized = { ...checked.value };
      delete normalized.approval_token;
      const proposal = allayProposalDto.safeParse({ tool: toolName, arguments: normalized });
      if (!proposal.success) return { kind: "outcome", outcome };
      return { kind: "proposal", proposal: proposal.data };
    },

    async executeConfirmed(proposal) {
      const parsed = allayProposalDto.parse(proposal);
      return confirmed.invoke(parsed.tool, {
        ...parsed.arguments,
        approval_token: MANUAL_CONFIRMATION_MARKER,
      });
    },
  };
}

export function isAllayReadTool(name: string): name is "list_servers" | "get_server" {
  return ALLAY_READ_TOOLS.has(name as AllayMcpToolName);
}
