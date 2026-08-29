import type {
  AbortResponse,
  Deployment,
  PreviewDeployResponse,
  Refusal,
  RollupMetrics,
  ServerSummary,
} from "@farlands/contracts";
import { isRefusal } from "@farlands/contracts";
import { CliError } from "./errors.ts";

/**
 * The HTTP client for the one API the CLI is a client of.
 *
 * fetch is a parameter rather than a global. The mock API is an Elysia app whose
 * handle() has exactly this signature, so the tests drive the real command tree
 * against the real routes without binding a port or spawning a process.
 */
export type FetchLike = (request: Request) => Promise<Response>;

export interface ApiOptions {
  baseUrl: string;
  token: string | null;
  fetch: FetchLike;
}

/**
 * A refusal is a value, not a failure. Transport and server faults throw;
 * "you are not allowed to do this, here is why" is returned, because the caller
 * has to render it rather than recover from it.
 */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

export interface RuleVersionSummary {
  version: number;
  content_digest: string;
  source: string;
  source_prompt: string | null;
  created_at: string;
}

export class ApiClient {
  constructor(private readonly options: ApiOptions) {}

  private url(path: string): string {
    return `${this.options.baseUrl}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json", ...extra };
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
    return headers;
  }

  private async send(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; parsed: unknown }> {
    const headers = this.headers(extraHeaders);
    if (body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await this.options.fetch(
        new Request(this.url(path), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    } catch (error) {
      throw new CliError(`Could not reach ${this.url(path)}: ${describe(error)}`, {
        hint: "Check FARLANDS_API, or start the mock with: bun run mock",
      });
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: "unparseable_response", body: text.slice(0, 400) };
      }
    }
    return { status: response.status, parsed };
  }

  private async expect<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, parsed } = await this.send(method, path, body);
    if (status >= 400) throw httpError(method, this.url(path), status, parsed);
    return parsed as T;
  }

  private async refusable<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const { status, parsed } = await this.send(method, path, body);
    // The API answers a refusal with 403 and the structured body. Any other
    // failure is a fault, and faults are not refusals: conflating them would let
    // a script treat a 502 as "ask a human for approval".
    if (status === 403 && isRefusal(parsed)) return { ok: false, refusal: parsed };
    if (status >= 400) throw httpError(method, this.url(path), status, parsed);
    return { ok: true, value: parsed as T };
  }

  listServers(): Promise<{ items: ServerSummary[]; next_cursor: string | null }> {
    return this.expect("GET", "/v1/servers");
  }

  getServer(serverId: string): Promise<ServerSummary> {
    return this.expect("GET", `/v1/servers/${serverId}`);
  }

  listRuleSets(
    serverId: string,
  ): Promise<{ items: RuleVersionSummary[]; next_cursor: string | null }> {
    return this.expect("GET", `/v1/servers/${serverId}/rule-sets`);
  }

  authorRules(serverId: string, prompt: string): Promise<unknown> {
    return this.expect("POST", `/v1/servers/${serverId}/rule-sets/author`, { prompt });
  }

  preview(serverId: string): Promise<PreviewDeployResponse> {
    return this.expect("POST", `/v1/servers/${serverId}/preview`, {});
  }

  telemetry(
    serverId: string,
    window: string,
  ): Promise<{
    server_id: string;
    window_start: string;
    window_end: string;
    metrics: RollupMetrics;
  }> {
    return this.expect("GET", `/v1/servers/${serverId}/telemetry?window=${window}`);
  }

  deploy(
    serverId: string,
    input: { rule_set_version: number; approval_token?: string },
  ): Promise<ApiResult<{ deployment: Deployment }>> {
    return this.refusable("POST", `/v1/servers/${serverId}/deploy`, input);
  }

  rollback(
    serverId: string,
    input: { approval_token?: string },
  ): Promise<ApiResult<{ deployment: Deployment }>> {
    return this.refusable("POST", `/v1/servers/${serverId}/rollback`, input);
  }

  getDeployment(deploymentId: string): Promise<{ deployment: Deployment }> {
    return this.expect("GET", `/v1/deployments/${deploymentId}`);
  }

  abortDeployment(deploymentId: string): Promise<AbortResponse> {
    return this.expect("POST", `/v1/deployments/${deploymentId}/abort`);
  }

  /** The SSE stream. Returns the raw body so the caller owns cancellation. */
  async openEvents(
    serverId: string,
    options: { lastEventId?: string | null; signal?: AbortSignal } = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const headers = this.headers({ accept: "text/event-stream" });
    if (options.lastEventId) headers["last-event-id"] = options.lastEventId;

    const init: RequestInit = { method: "GET", headers };
    if (options.signal) init.signal = options.signal;

    const response = await this.options.fetch(
      new Request(this.url(`/v1/servers/${serverId}/events`), init),
    );
    if (response.status >= 400 || !response.body) {
      throw new CliError(`Event stream for ${serverId} returned ${response.status}.`);
    }
    return response.body;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpError(method: string, url: string, status: number, parsed: unknown): CliError {
  const detail =
    typeof parsed === "object" && parsed !== null && "message" in parsed
      ? String((parsed as { message: unknown }).message)
      : "";
  const suffix = detail ? `: ${detail}` : "";
  return new CliError(`${method} ${url} returned ${status}${suffix}`);
}
