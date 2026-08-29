import { describe, expect, test } from "bun:test";
import { DRAFT_RATE_LIMIT } from "@farlands/contracts";
import type { ApiClient, ApiRequest } from "../src/api-client.ts";
import { createToolInvoker } from "../src/dispatch.ts";
import { recordingToolLogger } from "../src/logging.ts";
import { draftRateLimitKey, InMemoryRateLimiter } from "../src/rate-limit.ts";
import {
  bodyOf,
  callerFor,
  draftLimitedRig,
  matchesContract,
  OTHER,
  OWNED_SERVER,
  OWNER,
  rigFor,
} from "./support.ts";

/**
 * The draft rate limit is enforced here, not asked for politely.
 *
 * Two properties matter. It is server side, so a caller cannot decline to be
 * limited; and its response is a different shape from an approval refusal,
 * because the correct next move differs: wait, rather than ask a human.
 */

function countingApi(): ApiClient & { calls: ApiRequest[] } {
  const calls: ApiRequest[] = [];
  return {
    calls,
    async send(_caller, request) {
      calls.push(request);
      return { status: 200, ok: true, body: { version: { version: 4 } } };
    },
  };
}

describe("the limit is enforced", () => {
  test("draft calls beyond the limit are refused", async () => {
    const { invoker } = draftLimitedRig(2);
    const args = { server_id: OWNED_SERVER, version: 3 };

    expect((await invoker.call("preview_deploy", args)).isError).toBe(false);
    expect((await invoker.call("preview_deploy", args)).isError).toBe(false);

    const third = await invoker.call("preview_deploy", args);
    expect(third.isError).toBe(true);
    expect(bodyOf(third).error).toBe("rate_limited");
  });

  test("the refusal matches the committed RateLimitedRefusal schema", async () => {
    const { invoker } = draftLimitedRig(1);
    const args = { server_id: OWNED_SERVER, version: 3 };

    await invoker.call("preview_deploy", args);
    const body = bodyOf(await invoker.call("preview_deploy", args));

    expect(matchesContract("RateLimitedRefusal", body)).toBe(true);
  });

  test("it is charged before the API is called, so a limited call costs nothing", async () => {
    const api = countingApi();
    const invoker = createToolInvoker({
      caller: callerFor(OWNER),
      api,
      limiter: new InMemoryRateLimiter({ limit: 1, windowSeconds: 3600 }),
      logger: recordingToolLogger(),
    });

    await invoker.call("author_rules", { server_id: OWNED_SERVER, prompt: "more zombies" });
    expect(api.calls).toHaveLength(1);

    const refused = await invoker.call("author_rules", {
      server_id: OWNED_SERVER,
      prompt: "even more zombies",
    });
    expect(bodyOf(refused).error).toBe("rate_limited");
    expect(api.calls).toHaveLength(1);
  });

  test("both draft tools draw on the same per server budget", async () => {
    const { invoker } = draftLimitedRig(2);

    await invoker.call("author_rules", { server_id: OWNED_SERVER, prompt: "one" });
    await invoker.call("preview_deploy", { server_id: OWNED_SERVER, version: 3 });
    const third = await invoker.call("author_rules", { server_id: OWNED_SERVER, prompt: "two" });

    expect(bodyOf(third).error).toBe("rate_limited");
  });
});

describe("the limit is scoped the way the contract says", () => {
  test("the key is the principal and the server together", () => {
    expect(draftRateLimitKey(OWNER, OWNED_SERVER)).toBe(`${OWNER}:${OWNED_SERVER}`);
    expect(draftRateLimitKey(OWNER, OWNED_SERVER)).not.toBe(draftRateLimitKey(OTHER, OWNED_SERVER));
    expect(DRAFT_RATE_LIMIT.scope).toBe("principal+server");
  });

  test("one caller exhausting a server does not limit another server", async () => {
    const limiter = new InMemoryRateLimiter({ limit: 1, windowSeconds: 3600 });

    expect((await limiter.consume(draftRateLimitKey(OWNER, "srv_aaa"))).allowed).toBe(true);
    expect((await limiter.consume(draftRateLimitKey(OWNER, "srv_aaa"))).allowed).toBe(false);
    expect((await limiter.consume(draftRateLimitKey(OWNER, "srv_bbb"))).allowed).toBe(true);
  });

  test("one caller exhausting a server does not limit another caller", async () => {
    const limiter = new InMemoryRateLimiter({ limit: 1, windowSeconds: 3600 });

    await limiter.consume(draftRateLimitKey(OWNER, OWNED_SERVER));
    expect((await limiter.consume(draftRateLimitKey(OWNER, OWNED_SERVER))).allowed).toBe(false);
    expect((await limiter.consume(draftRateLimitKey(OTHER, OWNED_SERVER))).allowed).toBe(true);
  });

  test("the window slides, so the budget returns", async () => {
    let clock = 1_000_000;
    const limiter = new InMemoryRateLimiter({
      limit: 1,
      windowSeconds: 60,
      now: () => clock,
    });

    expect((await limiter.consume("k")).allowed).toBe(true);
    const denied = await limiter.consume("k");
    expect(denied.allowed).toBe(false);
    expect(denied.retry_after_seconds).toBeGreaterThan(0);

    clock += 61_000;
    expect((await limiter.consume("k")).allowed).toBe(true);
  });

  test("its defaults come from the contract, not from this package", async () => {
    const limiter = new InMemoryRateLimiter();
    const verdict = await limiter.consume("defaults");

    expect(verdict.limit).toBe(DRAFT_RATE_LIMIT.calls);
    expect(verdict.window_seconds).toBe(DRAFT_RATE_LIMIT.window_seconds);
  });
});

describe("a rate limit refusal is not an approval refusal", () => {
  test("different error code, and it says wait rather than ask", async () => {
    const { invoker } = draftLimitedRig(0);
    const body = bodyOf(
      await invoker.call("preview_deploy", { server_id: OWNED_SERVER, version: 3 }),
    );

    expect(body.error).toBe("rate_limited");
    expect(body.error).not.toBe("approval_required");
    expect(body).not.toHaveProperty("content_digest");
    expect(body).not.toHaveProperty("reason");
    expect(String(body.resolution)).toContain("Wait");
    expect(String(body.resolution)).toContain("No approval is needed");
  });

  test("it tells the caller how long to wait", async () => {
    const { invoker } = draftLimitedRig(0);
    const body = bodyOf(
      await invoker.call("author_rules", { server_id: OWNED_SERVER, prompt: "x" }),
    );

    expect(typeof body.retry_after_seconds).toBe("number");
    expect(body.limit).toBe(0);
    expect(body.window_seconds).toBe(3600);
  });
});

describe("only draft tools are limited", () => {
  test("read tools are never charged against the budget", async () => {
    const { invoker } = draftLimitedRig(0);

    for (const call of [
      invoker.call("list_servers", {}),
      invoker.call("get_server", { server_id: OWNED_SERVER }),
      invoker.call("get_world_telemetry", { server_id: OWNED_SERVER }),
    ]) {
      const body = bodyOf(await call);
      expect(body.error).not.toBe("rate_limited");
    }
  });

  test("act tools are never charged against the budget", async () => {
    const { invoker } = draftLimitedRig(0);
    const body = bodyOf(
      await invoker.call("deploy_rules", { server_id: OWNED_SERVER, version: 3 }),
    );

    expect(body.error).toBe("approval_required");
  });

  test("the shared rig with no limiter leaves reads unaffected", async () => {
    const { invoker } = rigFor();
    expect((await invoker.call("list_servers", {})).isError).toBe(false);
  });
});
