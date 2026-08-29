/**
 * Where clients look for the API.
 *
 * One definition, because there were three: the CLI defaulted to port 4000, the
 * MCP server to 3000, and the mock actually listens on 4010. They also read two
 * different environment variables. The result was that starting the mock and
 * running the CLI failed to connect, and the error told the user to do the thing
 * they had just done.
 *
 * None of the tests caught it. Every harness injects a base URL, so the defaults
 * were the one part of the configuration nothing exercised.
 */

export const API_BASE_URL_ENV = "FARLANDS_API_URL";

/**
 * Deprecated alias, still read so existing shells keep working. Remove once
 * nothing sets it.
 */
export const API_BASE_URL_ENV_LEGACY = "FARLANDS_API";

/**
 * Points at the mock, because the mock is the only server that exists. Change
 * this when apps/api serves for real, and change it here rather than in each
 * client.
 */
export const DEFAULT_API_BASE_URL = "http://127.0.0.1:4010";

/** Resolve the base URL from an environment, honouring the legacy name. */
export function resolveApiBaseUrl(env: Record<string, string | undefined>): string {
  return env[API_BASE_URL_ENV] ?? env[API_BASE_URL_ENV_LEGACY] ?? DEFAULT_API_BASE_URL;
}
