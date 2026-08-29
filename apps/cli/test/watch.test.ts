import { describe, expect, test } from "bun:test";
import { PROVISIONAL_STALL_BUDGET_MS } from "@farlands/contracts";
import { app } from "../../../tools/mock-api/src/app.ts";
import type { FetchLike } from "../src/api.ts";
import { ApiClient } from "../src/api.ts";
import { subscribe } from "../src/sse.ts";
import { stallBudget } from "../src/watch.ts";
import {
  authorisedEnv,
  MACHINE_TOKEN,
  mintApproval,
  mockHandle,
  parseNdjson,
  runFarlands,
  SERVER,
  transitionsOf,
  VERSION,
} from "./harness.ts";

/**
 * The watch loop: the stream, the poll fallback, and the stall budget.
 *
 * A deployment that fails is easy, because there is an error to react to. A
 * deployment that hangs is the case nobody handles, and it is the reason one
 * object per transition is a contract rather than a formatting choice.
 */

const WATCH_ARGS = ["--watch", "--json", "--poll-interval-ms", "30"] as const;

function deployArgv(extra: readonly string[] = []): string[] {
  return ["deploy", SERVER, "--version", String(VERSION), ...WATCH_ARGS, ...extra];
}

describe("the happy path follows to idle", () => {
  test("every state is reported and the run ends at idle", async () => {
    const run = await runFarlands(deployArgv(["--stall-budget-ms", "4000"]), {
      env: await authorisedEnv(),
      scenario: "happy",
      stepMs: 4,
    });

    const states = transitionsOf(parseNdjson(run.stdout)).map((record) => String(record.state));
    expect(states.at(0)).toBe("queued");
    expect(states.at(-1)).toBe("idle");
    expect(states).toContain("presync");
    expect(states).toContain("cutover");
    expect(run.exitCode).toBe(0);
  }, 15_000);

  test("the closing record carries the rollback command", async () => {
    const run = await runFarlands(deployArgv(["--stall-budget-ms", "4000"]), {
      env: await authorisedEnv(),
      scenario: "happy",
      stepMs: 4,
    });

    const closed = parseNdjson(run.stdout).find((record) => record.event === "deployment_closed");
    expect(closed?.final_state).toBe("idle");
    expect(closed?.rollback_command).toBe(`farlands rollback ${SERVER}`);
  }, 15_000);
});

describe("a stalled deployment is detected", () => {
  test("the stall is reported against a budget that says it is provisional", async () => {
    const run = await runFarlands(deployArgv(["--stall-budget-ms", "120"]), {
      env: await authorisedEnv(),
      scenario: "stall",
      stepMs: 4,
    });

    const records = parseNdjson(run.stdout);
    const stall = records.find((record) => record.event === "deployment_stalled");

    expect(stall).toBeDefined();
    // The mock's stall scenario halts at presync and emits nothing further.
    expect(stall?.state).toBe("presync");
    expect(stall?.budget_source).toBe("provisional");
    expect(stall?.policy).toBe("report");
    expect(Number(stall?.elapsed_ms)).toBeGreaterThanOrEqual(120);

    // Reported, not aborted. A stall left running is its own exit code, because
    // the deployment is neither finished nor failed.
    expect(records.some((record) => record.state === "aborted")).toBe(false);
    expect(run.exitCode).toBe(4);
  }, 15_000);

  test("the default is to report, never to abort silently", async () => {
    const run = await runFarlands(deployArgv(["--stall-budget-ms", "120"]), {
      env: await authorisedEnv(),
      scenario: "stall",
      stepMs: 4,
    });
    const states = transitionsOf(parseNdjson(run.stdout)).map((record) => String(record.state));
    expect(states.at(-1)).toBe("presync");
  }, 15_000);
});

describe("a stalled deployment can be aborted", () => {
  test("--on-stall abort calls abort and follows the deployment to aborted", async () => {
    const run = await runFarlands(deployArgv(["--stall-budget-ms", "120", "--on-stall", "abort"]), {
      env: await authorisedEnv(),
      scenario: "stall",
      stepMs: 4,
    });

    const records = parseNdjson(run.stdout);
    const stall = records.find((record) => record.event === "deployment_stalled");
    expect(stall?.policy).toBe("abort");

    const states = transitionsOf(records).map((record) => String(record.state));
    expect(states.at(-1)).toBe("aborted");

    const closed = records.find((record) => record.event === "deployment_closed");
    expect(closed?.final_state).toBe("aborted");
    expect(run.exitCode).toBe(3);
  }, 15_000);

  test("the abort really happened, and the mock agrees the deployment is aborted", async () => {
    const run = await runFarlands(deployArgv(["--stall-budget-ms", "120", "--on-stall", "abort"]), {
      env: await authorisedEnv(),
      scenario: "stall",
      stepMs: 4,
    });

    const transitions = transitionsOf(parseNdjson(run.stdout));
    const deploymentId = String(transitions[0]?.deployment_id);
    const response = await app.handle(new Request(`http://mock/v1/deployments/${deploymentId}`));
    const body = (await response.json()) as { deployment: { state: string } };

    expect(body.deployment.state).toBe("aborted");
  }, 15_000);
});

describe("polling is the fallback when the stream is not there", () => {
  test("a deployment still follows to idle with the event stream unavailable", async () => {
    const run = await runFarlands(deployArgv(["--stall-budget-ms", "4000"]), {
      env: await authorisedEnv(),
      scenario: "happy",
      stepMs: 30,
      breakEventStream: true,
    });

    const states = transitionsOf(parseNdjson(run.stdout)).map((record) => String(record.state));
    expect(states.at(-1)).toBe("idle");
    expect(run.exitCode).toBe(0);
    // The degradation is announced, on stderr, where it does not corrupt stdout.
    expect(run.stderr).toContain("event stream");
  }, 20_000);
});

describe("Last-Event-ID resumes a dropped stream", () => {
  test("the reconnect carries the last id the reader saw", async () => {
    const opens: (string | null)[] = [];
    let opened = 0;

    const fetchImpl: FetchLike = async (request) => {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/events")) return mockHandle(request);

      opened += 1;
      opens.push(request.headers.get("last-event-id"));
      const response = await mockHandle(request);
      if (opened > 1 || !response.body) return response;
      // Deliver one chunk and end the stream, which is what a recycled idle
      // connection looks like from the client side.
      return new Response(firstChunkOnly(response.body), { headers: response.headers });
    };

    const api = new ApiClient({ baseUrl: "http://mock", token: MACHINE_TOKEN, fetch: fetchImpl });

    // A deployment slow enough that events are still arriving when the first
    // stream is cut.
    const token = await mintApproval();
    await app.handle(
      new Request(`http://mock/v1/servers/${SERVER}/deploy?scenario=happy&step_ms=25`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rule_set_version: VERSION, approval_token: token }),
      }),
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let received = 0;
    try {
      for await (const event of subscribe(api, {
        serverId: SERVER,
        signal: controller.signal,
      })) {
        if (event.type === "deployment_state") received += 1;
        if (opened >= 2 && received >= 2) break;
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }

    expect(opens.length).toBeGreaterThanOrEqual(2);
    expect(opens[0]).toBeNull();
    // The resume is the whole point: without it a dropped socket turns into a
    // missing transition, which a watch loop reads as a stall.
    expect(opens[1]).not.toBeNull();
    expect(String(opens[1])).toMatch(/^\d{12}$/);
  }, 20_000);
});

describe("the stall budgets are the contract's, and provisional", () => {
  test("the budget table is read from contracts, not restated here", () => {
    expect(stallBudget("presync")).toBe(PROVISIONAL_STALL_BUDGET_MS.presync);
    expect(stallBudget("verifying")).toBe(PROVISIONAL_STALL_BUDGET_MS.verifying);
  });

  test("queued has no budget, so a queue is never mistaken for a hang", () => {
    // A deployment can sit in queued behind the cluster-wide serialisation for
    // as long as the queue is long. That is a wait, not a stall.
    expect(stallBudget("queued")).toBeNull();
    expect(stallBudget("idle")).toBeNull();
  });
});

/**
 * One chunk, then end of stream: what a recycled idle connection looks like.
 *
 * The inner reader is released rather than cancelled. The mock publishes into a
 * stream controller it holds itself, so cancelling from this end would close
 * that controller and make its next publish throw, which is a property of the
 * mock rather than of anything the CLI does.
 */
function firstChunkOnly(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (!chunk.done && chunk.value) controller.enqueue(chunk.value);
      controller.close();
      reader.releaseLock();
    },
  });
}
