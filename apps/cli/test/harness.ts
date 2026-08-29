import { TOKEN_PREFIX } from "@farlands/contracts";
// The mock API is the development target. It is imported as a module and driven
// through app.handle(), which has the same signature as the fetch the CLI takes
// as a parameter, so the whole suite runs the real command tree against the real
// routes with no port bound and no process spawned.
import { app } from "../../../tools/mock-api/src/app.ts";
import type { FetchLike } from "../src/api.ts";
import type { CliDeps } from "../src/cli.ts";
import { runCli } from "../src/cli.ts";

export const SERVER = "srv_7f2";
export const VERSION = 3;
export const MACHINE_TOKEN = `${TOKEN_PREFIX.machine}test`;

export interface Capture {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  /** Mock scenario for the deploy route: happy, stall, abort_at_verifying, fail_at_building. */
  scenario?: string;
  stepMs?: number;
  /** Simulates an SSE endpoint that is unavailable, to exercise the poll fallback. */
  breakEventStream?: boolean;
  readTextFile?: (path: string) => string | null;
  homeDir?: string | null;
}

async function rebuild(request: Request, url: URL): Promise<Request> {
  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  return new Request(url.toString(), {
    method: request.method,
    headers: request.headers,
    ...(body ? { body } : {}),
  });
}

/**
 * Hand a request to the mock with its abort signal removed.
 *
 * The CLI aborts the request when it stops following a stream, which is the
 * correct way to end a subscription over a real connection. The mock builds its
 * event stream from a ReadableStream with no cancel handler, so an abort closes
 * that controller while the mock is still subscribed to publish into it, and its
 * next publish faults for every later test in the process. Dropping the signal
 * here keeps the mock alive without weakening what the CLI does, and the fix
 * belongs in the mock rather than in this harness.
 */
export async function mockHandle(request: Request): Promise<Response> {
  return app.handle(await rebuild(request, new URL(request.url)));
}

/**
 * The mock, with the two knobs the mock exposes through query parameters.
 *
 * Those parameters are a property of the mock and not of the API, so they are
 * added here rather than becoming flags on a production binary.
 */
export function mockFetch(options: RunOptions = {}): FetchLike {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (options.breakEventStream && url.pathname.endsWith("/events")) {
      return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
    }

    if (request.method === "POST" && url.pathname.endsWith("/deploy")) {
      if (options.scenario) url.searchParams.set("scenario", options.scenario);
      url.searchParams.set("step_ms", String(options.stepMs ?? 5));
    }

    return app.handle(await rebuild(request, url));
  };
}

export async function runFarlands(
  argv: readonly string[],
  options: RunOptions = {},
): Promise<Capture> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const deps: CliDeps = {
    stdout: (chunk) => stdout.push(chunk),
    stderr: (chunk) => stderr.push(chunk),
    env: options.env ?? { FARLANDS_TOKEN: MACHINE_TOKEN, FARLANDS_API: "http://mock" },
    fetch: mockFetch(options),
    readTextFile: options.readTextFile ?? (() => null),
    homeDir: options.homeDir ?? null,
    // Human mode is asked for colour explicitly, so a test run in CI and a test
    // run in a terminal render the same bytes.
    color: true,
  };

  const exitCode = await runCli(argv, deps);
  return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
}

async function callMock(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await app.handle(
    new Request(`http://mock${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    }),
  );
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/** The digest an approval binds to, read the way the CLI reads it. */
export async function currentDigest(serverId = SERVER): Promise<string> {
  const body = (await callMock(`/v1/servers/${serverId}/rule-sets`)) as {
    items: { content_digest: string }[];
  };
  const latest = body.items.at(-1);
  if (!latest) throw new Error(`the mock has no rule versions for ${serverId}`);
  return latest.content_digest;
}

/** Mint an approval token through the mock, as the dashboard would. */
export async function mintApproval(serverId = SERVER, version = VERSION): Promise<string> {
  const body = (await callMock("/v1/approvals", {
    method: "POST",
    body: JSON.stringify({
      server_id: serverId,
      rule_set_version: version,
      content_digest: await currentDigest(serverId),
    }),
  })) as { token: string };
  return body.token;
}

export async function authorisedEnv(): Promise<Record<string, string>> {
  return {
    FARLANDS_TOKEN: MACHINE_TOKEN,
    FARLANDS_API: "http://mock",
    FARLANDS_APPROVAL_TOKEN: await mintApproval(),
  };
}

/** NDJSON in, objects out, with the parse failure named rather than swallowed. */
export function parseNdjson(text: string): Record<string, unknown>[] {
  const lines = text.split("\n").filter((line) => line !== "");
  return lines.map((line, index) => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not a JSON object");
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `line ${index + 1} is not one JSON object: ${line}\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

/** The escape byte every ANSI sequence begins with. */
export const ESC = String.fromCharCode(0x1b);

/**
 * Offending code points in a stream that is supposed to be pure NDJSON.
 *
 * Stronger than matching known ANSI sequences, and deliberately so. Matching a
 * pattern only rules out the forms somebody remembered to write down, whereas a
 * consumer-safe NDJSON stream contains no C0 control characters at all except
 * the newline that separates records. That also covers the 8 bit CSI
 * introducer, which a colour library on a terminal that negotiated it could
 * emit without ever writing an escape byte.
 */
export function controlCharactersIn(text: string): { index: number; code: number }[] {
  const offending: { index: number; code: number }[] = [];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x0a) continue;
    if (code < 0x20 || code === 0x7f || code === 0x9b) offending.push({ index, code });
  }
  return offending;
}

export function transitionsOf(records: Record<string, unknown>[]): Record<string, unknown>[] {
  return records.filter((record) => record.event === "deployment_state");
}

/**
 * The keys a contract object defines, read from the schema itself.
 *
 * @sinclair/typebox is not a dependency of this workspace, and adding one to run
 * a validator in a test would be the wrong trade. The schema objects are plain
 * data, so the expectation is derived from the contract rather than retyped
 * here, which is the property that actually matters: a contract change breaks
 * this test instead of quietly passing it.
 */
export function contractKeys(schema: { properties: Record<string, unknown> }): string[] {
  return Object.keys(schema.properties).sort();
}

export function keysOf(value: Record<string, unknown> | undefined): string[] {
  return Object.keys(value ?? {}).sort();
}
