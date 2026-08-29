import { TOOL_DEFINITIONS, type ToolDefinition, type ToolName } from "@farlands/contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ApiClient } from "./api-client.ts";
import type { Caller } from "./caller.ts";
import { redactArguments, type ToolLogger } from "./logging.ts";
import { draftRateLimitKey, type RateLimiter } from "./rate-limit.ts";
import { failed, rateLimited, refused, type ToolOutcome, toCallToolResult } from "./results.ts";
import { validateToolArguments } from "./schema.ts";
import { TOOL_IMPLEMENTATIONS } from "./tools/index.ts";

/**
 * The one path every tool call takes.
 *
 * Validation, the draft rate limit, the tool body and the log line all happen
 * here, in that order, for every tool. Putting the class-dependent steps in the
 * dispatcher rather than in the tool bodies is what makes the class boundary
 * mean something operationally: a tool cannot forget to be rate limited, and no
 * tool can produce a call that leaves no log line.
 */

export interface DispatcherDeps {
  caller: Caller;
  api: ApiClient;
  limiter: RateLimiter;
  logger: ToolLogger;
  now?: () => number;
}

export interface ToolInvoker {
  /** Run a tool and return the raw outcome, already logged. */
  invoke(name: string, args: unknown): Promise<ToolOutcome>;
  /** Run a tool and return the MCP result an agent will render. */
  call(name: string, args: unknown): Promise<CallToolResult>;
}

function definitionFor(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name);
}

export function createToolInvoker(deps: DispatcherDeps): ToolInvoker {
  const now = deps.now ?? Date.now;

  async function invoke(name: string, args: unknown): Promise<ToolOutcome> {
    const startedAt = now();
    const supplied = toRecord(args);
    const definition = definitionFor(name);

    const outcome = await run(name, definition, args);

    deps.logger.record({
      event: "mcp_tool_call",
      ts: new Date(startedAt).toISOString(),
      transport: deps.caller.transport,
      caller: deps.caller.principal,
      tool: name,
      tool_class: definition?.class ?? "unknown",
      arguments: redactArguments(supplied),
      outcome: outcome.kind,
      code: outcome.code,
      duration_ms: Math.max(0, now() - startedAt),
    });

    return outcome;
  }

  async function run(
    name: string,
    definition: ToolDefinition | undefined,
    args: unknown,
  ): Promise<ToolOutcome> {
    if (!definition) {
      return failed("unknown_tool", {
        error: "unknown_tool",
        tool: name,
        message: `${name} is not a tool on this server.`,
        resolution: "Call tools/list and use one of the names it returns.",
      });
    }

    const checked = validateToolArguments(definition.name, args);
    if (!checked.ok) {
      return failed("invalid_arguments", {
        error: "invalid_arguments",
        tool: name,
        message: checked.message,
        resolution:
          "Fix the arguments to match this tool's input schema, which is generated from the shared contract types.",
      });
    }

    if (definition.class === "draft") {
      const limited = await enforceDraftLimit(definition.name, checked.value);
      if (limited) return limited;
    }

    const handler = TOOL_IMPLEMENTATIONS[definition.name];
    try {
      return await handler(checked.value, {
        caller: deps.caller,
        api: deps.api,
        limiter: deps.limiter,
      });
    } catch (cause) {
      // A bug in a tool body must not reach the transport as a JSON-RPC error.
      // An agent framework renders that as a stack trace, and a stack trace in
      // place of a refusal is exactly the failure this design is avoiding.
      return failed("tool_error", {
        error: "tool_error",
        tool: name,
        message: cause instanceof Error ? cause.message : String(cause),
        resolution: "Nothing was changed by this call. Report this to the operator.",
      });
    }
  }

  async function enforceDraftLimit(
    name: ToolName,
    args: Record<string, unknown>,
  ): Promise<ToolOutcome | null> {
    const serverId = typeof args.server_id === "string" ? args.server_id : "unknown";
    const verdict = await deps.limiter.consume(draftRateLimitKey(deps.caller.principal, serverId));
    if (verdict.allowed) return null;
    return refused(rateLimited({ tool: name, server_id: serverId, verdict }));
  }

  return {
    invoke,
    async call(name, args) {
      return toCallToolResult(await invoke(name, args));
    },
  };
}

function toRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return {};
  return args as Record<string, unknown>;
}
