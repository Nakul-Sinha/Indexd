import type { FetchLike } from "./api.ts";
import { ApiClient } from "./api.ts";
import type { CredentialSources } from "./auth.ts";
import { resolveBaseUrl, resolveMachineToken } from "./auth.ts";
import { CliError } from "./errors.ts";
import type { OutputPort } from "./output/index.ts";

/**
 * Everything the CLI touches that is not pure computation, in one object.
 *
 * The clock, the environment, the filesystem, the network and the two output
 * sinks are all parameters. That is what lets the test suite run the real
 * command tree against the real mock routes with no port bound, no process
 * spawned, and no dependence on the machine it runs on.
 */
export interface CliRuntime {
  out: OutputPort;
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  readTextFile: (path: string) => string | null;
  homeDir: string | null;
  now: () => number;
}

export function credentialSources(runtime: CliRuntime): CredentialSources {
  return { env: runtime.env, readTextFile: runtime.readTextFile, homeDir: runtime.homeDir };
}

/**
 * An authenticated client, or a clear error.
 *
 * Every command needs one, including the act commands: resolving the rule
 * version a refusal names is itself a read.
 */
export function apiFor(runtime: CliRuntime): ApiClient {
  const sources = credentialSources(runtime);
  const credential = resolveMachineToken(sources);
  if (!credential) {
    throw new CliError("No machine token configured.", {
      hint: "Set FARLANDS_TOKEN, or FARLANDS_TOKEN_FILE, or put a token in ~/.config/farlands/config.json. The CLI has no login command and never asks for a password.",
    });
  }
  return new ApiClient({
    baseUrl: resolveBaseUrl(sources),
    token: credential.token,
    fetch: runtime.fetch,
  });
}
