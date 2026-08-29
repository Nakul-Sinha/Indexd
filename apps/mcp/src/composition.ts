import {
  resolveApiBaseUrl,
  DEFAULT_API_BASE_URL as SHARED_DEFAULT_API_BASE_URL,
} from "@farlands/contracts";
import { type ApiClient, type FetchLike, HttpApiClient } from "./api-client.ts";
import type { Caller } from "./caller.ts";
import type { DispatcherDeps } from "./dispatch.ts";
import { stderrToolLogger, type ToolLogger } from "./logging.ts";
import { InMemoryRateLimiter, type RateLimiter } from "./rate-limit.ts";

/**
 * The composition root.
 *
 * Both transports drive the same tool implementations, so the only thing that
 * differs between them is how the caller is established. Everything else is
 * assembled here once, which is also where the in-memory rate limiter is swapped
 * for the Postgres backed one when there is more than one replica.
 */

export const DEFAULT_API_BASE_URL = SHARED_DEFAULT_API_BASE_URL;

export interface RuntimeOptions {
  apiBaseUrl?: string;
  /** Injected so tests can pass the mock API's own handler instead of a socket. */
  fetch?: FetchLike;
  principalHeader?: string;
  api?: ApiClient;
  logger?: ToolLogger;
  limiter?: RateLimiter;
}

export function readRuntimeOptions(env: Record<string, string | undefined>): RuntimeOptions {
  const options: RuntimeOptions = {
    apiBaseUrl: resolveApiBaseUrl(env),
  };
  if (env.FARLANDS_PRINCIPAL_HEADER) options.principalHeader = env.FARLANDS_PRINCIPAL_HEADER;
  return options;
}

export function buildDeps(caller: Caller, options: RuntimeOptions = {}): DispatcherDeps {
  const api =
    options.api ??
    new HttpApiClient({
      baseUrl: options.apiBaseUrl ?? DEFAULT_API_BASE_URL,
      fetch: options.fetch,
      principalHeader: options.principalHeader,
    });

  return {
    caller,
    api,
    limiter: options.limiter ?? new InMemoryRateLimiter(),
    logger: options.logger ?? stderrToolLogger(),
  };
}
