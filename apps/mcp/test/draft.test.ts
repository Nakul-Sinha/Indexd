import { describe, expect, test } from "bun:test";
import { UNMEASURED } from "@farlands/contracts";
import { deployments } from "../../../tools/mock-api/src/state.ts";
import type { ApiClient, ApiRequest } from "../src/api-client.ts";
import { createToolInvoker } from "../src/dispatch.ts";
import { recordingToolLogger } from "../src/logging.ts";
import { unlimited } from "../src/rate-limit.ts";
import { bodyOf, callerFor, OWNED_SERVER, OWNER, rigFor, SEEDED_VERSION } from "./support.ts";

/**
 * Draft tools produce something durable and change nothing live. The tests here
 * pin both halves of that: a preview never becomes a deployment, and a drafting
 * failure is an outcome rather than an exception.
 */

function recordingApi(response: { status: number; ok: boolean; body: unknown }) {
  const calls: ApiRequest[] = [];
  const api: ApiClient = {
    async send(_caller, request) {
      calls.push(request);
      return response;
    },
  };
  return { api, calls };
}

describe("preview_deploy", () => {
  test("returns a dry run and queues nothing", async () => {
    const { invoker } = rigFor();
    const before = deployments.size;

    const result = await invoker.call("preview_deploy", {
      server_id: OWNED_SERVER,
      version: SEEDED_VERSION,
    });
    const body = bodyOf(result);

    expect(result.isError).toBe(false);
    expect(body.server_id).toBe(OWNED_SERVER);
    expect(String(body.note)).toContain("Nothing was queued");
    expect(deployments.size).toBe(before);
  });

  test("never guesses the player-visible window", async () => {
    const { invoker } = rigFor();
    const body = bodyOf(
      await invoker.call("preview_deploy", { server_id: OWNED_SERVER, version: SEEDED_VERSION }),
    );
    const window = body.estimated_window as { measured: boolean; player_visible_ms: unknown };

    expect(window.measured).toBe(false);
    expect(window.player_visible_ms).toBe(UNMEASURED);
  });

  test("carries the rollback target and the quota impact", async () => {
    const { invoker } = rigFor();
    const body = bodyOf(
      await invoker.call("preview_deploy", { server_id: OWNED_SERVER, version: SEEDED_VERSION }),
    );

    expect(body).toHaveProperty("rollback_target");
    expect(body).toHaveProperty("quota_impact");
    expect(body).toHaveProperty("diff");
  });

  test("is scoped like a read", async () => {
    const { invoker } = rigFor();
    const body = bodyOf(await invoker.call("preview_deploy", { server_id: "srv_a19", version: 1 }));
    expect(body.error).toBe("not_found");
  });
});

describe("author_rules", () => {
  test("sends the prompt to the server-scoped authoring route", async () => {
    const { api, calls } = recordingApi({
      status: 200,
      ok: true,
      body: { version: { version: 4 }, diff: { entries: [] }, attempts: 1 },
    });
    const invoker = createToolInvoker({
      caller: callerFor(OWNER),
      api,
      limiter: unlimited,
      logger: recordingToolLogger(),
    });

    const body = bodyOf(
      await invoker.call("author_rules", {
        server_id: OWNED_SERVER,
        prompt: "make the nether hub harder at night",
      }),
    );

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe(`/v1/servers/${OWNED_SERVER}/rule-sets/author`);
    expect(calls[0]?.body).toEqual({ prompt: "make the nether hub harder at night" });
    expect(String(body.note)).toContain("Nothing was deployed");
  });

  test("a drafting failure is an outcome, not an exception", async () => {
    const { api } = recordingApi({
      status: 422,
      ok: false,
      body: {
        error: "authoring_failed",
        prompt: "give everyone god mode",
        attempts: 3,
        last_candidate: {},
        validation_errors: [{ path: "rules[0]", code: "forbidden", message: "not permitted" }],
        message: "The prompt could not be turned into a valid document.",
      },
    });
    const invoker = createToolInvoker({
      caller: callerFor(OWNER),
      api,
      limiter: unlimited,
      logger: recordingToolLogger(),
    });

    const result = await invoker.call("author_rules", {
      server_id: OWNED_SERVER,
      prompt: "give everyone god mode",
    });
    const body = bodyOf(result);

    expect(result.isError).toBe(true);
    expect(body.error).toBe("authoring_failed");
    expect(body.validation_errors).toBeDefined();
  });

  test("an empty prompt is rejected before anything is called", async () => {
    const { api, calls } = recordingApi({ status: 200, ok: true, body: {} });
    const invoker = createToolInvoker({
      caller: callerFor(OWNER),
      api,
      limiter: unlimited,
      logger: recordingToolLogger(),
    });

    const body = bodyOf(
      await invoker.call("author_rules", { server_id: OWNED_SERVER, prompt: "" }),
    );

    expect(body.error).toBe("invalid_arguments");
    expect(calls).toHaveLength(0);
  });

  test("a route the API does not serve fails as a value", async () => {
    const { invoker } = rigFor();
    const result = await invoker.call("author_rules", {
      server_id: OWNED_SERVER,
      prompt: "more zombies",
    });

    // The mock API has no authoring route yet. The point is that a missing route
    // surfaces as a readable error rather than a thrown one, and is not dressed
    // up as a scoping decision.
    expect(result.isError).toBe(true);
    expect(bodyOf(result).error).toBe("upstream_error");
  });
});
