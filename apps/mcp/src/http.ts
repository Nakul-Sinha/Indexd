import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { httpCaller, machineTokenFingerprint, machineTokenFromAuthorization } from "./caller.ts";
import { buildDeps, type RuntimeOptions } from "./composition.ts";
import { createFarlandsMcpServer } from "./server.ts";

/**
 * The Streamable HTTP transport: remote and hosted agents, authenticated with a
 * machine token.
 *
 * The token is not verified here. This layer requires one to be present and
 * well formed, binds it to the session, and forwards it on every API call; the
 * API decides what it can see. Checking it in two places would eventually mean
 * checking it two different ways.
 *
 * A session is pinned to the credential that opened it. Without that, a leaked
 * session id would be usable by anyone who learned it, which would make the
 * session a second and much weaker credential.
 */

export interface HttpHandlerOptions extends RuntimeOptions {
  /** Path the MCP endpoint is served from. Anything else is 404. */
  endpoint?: string;
  /** Host header values accepted, for DNS rebinding protection. */
  allowedHosts?: string[];
  allowedOrigins?: string[];
  /**
   * Map a machine token to the principal label used for logging and for the
   * draft rate limit bucket.
   *
   * The default is a fingerprint of the token, because this server does not know
   * who a token belongs to and should not claim to. The hook exists for the mock
   * API, which has no token store and needs the principal named for it.
   */
  resolvePrincipal?: (token: string) => string;
}

interface Session {
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  /**
   * Fingerprint of the token that opened the session, which is what a later
   * request is checked against. Pinning on the credential rather than on the
   * principal label matters because two tokens can share a label and must still
   * not share a session.
   */
  credential: string;
}

export interface HttpHandler {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
  readonly sessionCount: number;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function createHttpHandler(options: HttpHandlerOptions = {}): HttpHandler {
  const endpoint = options.endpoint ?? "/mcp";
  const sessions = new Map<string, Session>();

  async function open(token: string): Promise<Session> {
    const caller = httpCaller(token, options.resolvePrincipal?.(token));
    const server = createFarlandsMcpServer(buildDeps(caller, options));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      allowedHosts: options.allowedHosts,
      allowedOrigins: options.allowedOrigins,
      enableDnsRebindingProtection: (options.allowedHosts ?? options.allowedOrigins) !== undefined,
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
    });

    await server.connect(transport);
    return { server, transport, credential: machineTokenFingerprint(token) };
  }

  return {
    get sessionCount() {
      return sessions.size;
    },

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== endpoint) {
        return json(404, { error: "not_found", message: `No MCP endpoint at ${url.pathname}.` });
      }

      const token = machineTokenFromAuthorization(request.headers.get("authorization"));
      if (!token) {
        return json(
          401,
          {
            error: "unauthorized",
            message: "This endpoint requires a machine token.",
            resolution:
              "Send Authorization: Bearer flk_... . Human sessions are not accepted here, and no tool on this server mints an approval.",
          },
          { "www-authenticate": 'Bearer realm="farlands"' },
        );
      }

      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          return json(404, {
            error: "unknown_session",
            message: "No such MCP session. Initialize a new one.",
          });
        }
        if (existing.credential !== machineTokenFingerprint(token)) {
          // A session belongs to the credential that opened it. Refusing here
          // keeps the session id from becoming a bearer credential of its own.
          return json(403, {
            error: "session_principal_mismatch",
            message: "This session belongs to a different machine token.",
            resolution: "Initialize a session with your own token.",
          });
        }
        return existing.transport.handleRequest(request);
      }

      const session = await open(token);
      const response = await session.transport.handleRequest(request);
      const assigned = session.transport.sessionId;
      if (assigned) {
        sessions.set(assigned, session);
      } else {
        await session.server.close();
      }
      return response;
    },

    async close() {
      for (const session of sessions.values()) {
        await session.server.close();
      }
      sessions.clear();
    },
  };
}

export function startHttpServer(options: HttpHandlerOptions & { port?: number } = {}) {
  const handler = createHttpHandler(options);
  const port = options.port ?? Number(process.env.FARLANDS_MCP_PORT ?? 8787);
  const server = Bun.serve({ port, fetch: (request) => handler.fetch(request) });
  return {
    handler,
    port: server.port,
    async close() {
      await handler.close();
      await server.stop(true);
    },
  };
}

if (import.meta.main) {
  const { port } = startHttpServer();
  process.stderr.write(
    `${JSON.stringify({ event: "mcp_http_listening", port, endpoint: "/mcp" })}\n`,
  );
}
