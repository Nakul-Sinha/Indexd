/**
 * The MCP server: the platform as an agent action space.
 *
 * Thirteen tools in three classes, and the class boundary is the security
 * boundary. READ tools are scoped to the caller's own servers, DRAFT tools have
 * no live effect but are rate limited server side because they cost money, and
 * ACT tools carry a human-minted approval token and fail closed without one.
 *
 * Two transports drive the same implementations: stdio for an agent in a
 * terminal, and Streamable HTTP for remote agents authenticated with a machine
 * token.
 */

export type { ApiClient, ApiRequest, ApiResult, FetchLike } from "./api-client.ts";
export { HttpApiClient } from "./api-client.ts";
export type { Caller, TransportKind } from "./caller.ts";
export {
  httpCaller,
  isMachineToken,
  machineTokenFingerprint,
  machineTokenFromAuthorization,
  stdioCallerFromEnv,
} from "./caller.ts";
export type { RuntimeOptions } from "./composition.ts";
export { buildDeps, DEFAULT_API_BASE_URL, readRuntimeOptions } from "./composition.ts";
export type { DispatcherDeps, ToolInvoker } from "./dispatch.ts";
export { createToolInvoker } from "./dispatch.ts";
export type { HttpHandler, HttpHandlerOptions } from "./http.ts";
export { createHttpHandler, startHttpServer } from "./http.ts";
export type { RecordingToolLogger, ToolCallLog, ToolLogger, ToolOutcomeKind } from "./logging.ts";
export { recordingToolLogger, redactArguments, stderrToolLogger } from "./logging.ts";
export type { RateLimiter, RateLimitVerdict } from "./rate-limit.ts";
export { draftRateLimitKey, InMemoryRateLimiter, unlimited } from "./rate-limit.ts";
export type { ToolOutcome } from "./results.ts";
export {
  approvalRefusalFrom,
  failed,
  notFound,
  ok,
  rateLimited,
  refused,
  refusedUpstream,
  toCallToolResult,
} from "./results.ts";
export { describeRule, diffRuleDocuments } from "./rule-diff.ts";
export type { ArgumentCheck, ToolSurfaceDrift } from "./schema.ts";
export {
  assertToolSurface,
  generateToolSchemas,
  ToolSurfaceDriftError,
  toolSurfaceDrift,
  validateToolArguments,
} from "./schema.ts";
export {
  createFarlandsMcpServer,
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  SERVER_VERSION,
} from "./server.ts";
export { startStdioServer } from "./stdio.ts";
export type { ToolContext, ToolHandler } from "./tools/index.ts";
export { actTools, draftTools, readTools, TOOL_IMPLEMENTATIONS } from "./tools/index.ts";
