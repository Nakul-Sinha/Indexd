import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { stdioCallerFromEnv } from "./caller.ts";
import { buildDeps, type RuntimeOptions, readRuntimeOptions } from "./composition.ts";
import { createFarlandsMcpServer } from "./server.ts";

/**
 * The stdio transport: one agent, on one machine, as one principal.
 *
 * This is the demo path. There is no session and no per-request identity because
 * there is no multiplexing: the process is the session, and the machine token in
 * the environment is the caller for its whole life.
 */

export interface StdioOptions extends RuntimeOptions {
  env?: Record<string, string | undefined>;
}

export async function startStdioServer(options: StdioOptions = {}) {
  const env = options.env ?? process.env;
  const caller = stdioCallerFromEnv(env);
  const deps = buildDeps(caller, { ...readRuntimeOptions(env), ...options });

  const server = createFarlandsMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  return {
    server,
    transport,
    async close() {
      await server.close();
    },
  };
}

if (import.meta.main) {
  await startStdioServer();
}
