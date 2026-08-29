import type { Caller } from "./caller.ts";

/**
 * The HTTP seam to the control plane API.
 *
 * Every tool goes through here and nothing in this package talks to a database,
 * a cluster or a model directly. That is what makes the API the single place
 * where scoping and approval are decided, and it is what lets the tests drive
 * the whole tool surface against the mock API without binding a port.
 */

/** Narrower than `fetch` on purpose, so `app.handle` from the mock API fits it. */
export type FetchLike = (request: Request) => Promise<Response>;

export interface ApiRequest {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface ApiResult {
  /** Zero when the request never reached a server. */
  status: number;
  ok: boolean;
  body: unknown;
}

export interface ApiClient {
  send(caller: Caller, request: ApiRequest): Promise<ApiResult>;
}

export interface HttpApiClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  /**
   * Header carrying the caller's principal.
   *
   * The real API derives the principal from the machine token and this stays
   * unset. The mock API takes the principal from a header because it has no
   * token store, so pointing at the mock means naming that header. It is a
   * development-target accommodation and it is deliberately opt in, so a
   * production configuration cannot assert an identity by sending a header.
   */
  principalHeader?: string;
}

export class HttpApiClient implements ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly principalHeader: string | undefined;

  constructor(options: HttpApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((request) => globalThis.fetch(request));
    this.principalHeader = options.principalHeader;
  }

  async send(caller: Caller, request: ApiRequest): Promise<ApiResult> {
    const url = new URL(`${this.baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { accept: "application/json" };
    if (caller.token) headers.authorization = `Bearer ${caller.token}`;
    if (this.principalHeader) headers[this.principalHeader] = caller.principal;
    if (request.body !== undefined) headers["content-type"] = "application/json";

    const init: RequestInit = { method: request.method, headers };
    if (request.body !== undefined) init.body = JSON.stringify(request.body);

    let response: Response;
    try {
      response = await this.fetchImpl(new Request(url.toString(), init));
    } catch (cause) {
      // An unreachable API is returned as a value rather than thrown, so an act
      // tool can fail closed on it instead of surfacing a stack trace.
      return {
        status: 0,
        ok: false,
        body: { error: "upstream_unreachable", detail: describe(cause) },
      };
    }

    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: "upstream_unparseable", detail: text.slice(0, 500) };
      }
    }

    return { status: response.status, ok: response.ok, body };
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
