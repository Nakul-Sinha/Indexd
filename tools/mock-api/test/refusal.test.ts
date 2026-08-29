import { describe, expect, test } from "bun:test";
import { ApprovalRequiredRefusal, contentDigest } from "@farlands/contracts";
import { Value } from "@sinclair/typebox/value";
import { app } from "../src/app.ts";

/**
 * The refusal path, exercised end to end against the mock.
 *
 * This is the M5 demo condition built months before the real controller exists:
 * an agent drafts a change, calls deploy, and is correctly refused. Every one of
 * the five approval failure modes is covered here, because "fails closed" is a
 * claim that needs all five to be true and not just the obvious one.
 */

const SERVER = "srv_7f2";
const VERSION = 3;

async function call(path: string, init: RequestInit = {}, principal = "usr_demo") {
  const response = await app.handle(
    new Request(`http://mock${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-mock-principal": principal,
        ...(init.headers ?? {}),
      },
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function currentDigest(): Promise<string> {
  const { body } = await call(`/v1/servers/${SERVER}/rule-sets`);
  return body.items.at(-1).content_digest;
}

async function mint(overrides: Record<string, unknown> = {}, principal = "usr_demo") {
  const { body } = await call(
    "/v1/approvals",
    {
      method: "POST",
      body: JSON.stringify({
        server_id: SERVER,
        rule_set_version: VERSION,
        content_digest: await currentDigest(),
        ...overrides,
      }),
    },
    principal,
  );
  return body.token as string;
}

async function deploy(token: string | undefined, principal = "usr_demo") {
  return call(
    `/v1/servers/${SERVER}/deploy?scenario=happy&step_ms=5`,
    {
      method: "POST",
      body: JSON.stringify({
        rule_set_version: VERSION,
        ...(token ? { approval_token: token } : {}),
      }),
    },
    principal,
  );
}

describe("deploy fails closed", () => {
  test("with no token at all", async () => {
    const { status, body } = await deploy(undefined);
    expect(status).toBe(403);
    expect(body.error).toBe("approval_required");
    expect(body.reason).toBe("missing");
  });

  test("with a token that was never minted", async () => {
    const { body } = await deploy("apv_not_a_real_token");
    expect(body.reason).toBe("missing");
  });

  test("with a token already spent", async () => {
    const token = await mint();
    const first = await deploy(token);
    expect(first.status).toBe(200);

    const second = await deploy(token);
    expect(second.status).toBe(403);
    expect(second.body.reason).toBe("consumed");
  });

  test("with an expired token", async () => {
    const token = await mint({ ttl_seconds: -1 });
    const { body } = await deploy(token);
    expect(body.reason).toBe("expired");
  });

  test("with a token issued to a different principal", async () => {
    const token = await mint({ issued_to: "usr_someone_else" });
    const { body } = await deploy(token);
    expect(body.reason).toBe("principal_mismatch");
  });

  test("with a token minted against different content", async () => {
    // Time of check against time of use: approve a benign document, then try to
    // deploy something else under the same version claim.
    const token = await mint({ content_digest: contentDigest({ something: "else" }) });
    const { body } = await deploy(token);
    expect(body.reason).toBe("digest_mismatch");
  });

  test("every refusal matches the contract type exactly", async () => {
    const { body } = await deploy(undefined);
    expect(Value.Check(ApprovalRequiredRefusal, body)).toBe(true);
  });

  test("the refusal tells the caller to ask a human, never to retry", async () => {
    const { body } = await deploy(undefined);
    expect(body.resolution).toContain("owner");
    expect(body.resolution.toLowerCase()).not.toContain("try again");
  });
});

describe("read tools are scoped", () => {
  test("a server you do not own is not found, rather than empty", async () => {
    const { status, body } = await call("/v1/servers/srv_a19");
    expect(status).toBe(404);
    expect(body.error).toBe("not_found");
  });

  test("telemetry for someone else's server is refused", async () => {
    const { status } = await call("/v1/servers/srv_a19/telemetry");
    expect(status).toBe(404);
  });

  test("listing shows only your own servers", async () => {
    const { body } = await call("/v1/servers");
    expect(body.items.map((s: { server_id: string }) => s.server_id)).toEqual(["srv_7f2"]);
  });
});

describe("preview never guesses the freeze window", () => {
  test("reports unmeasured until M1 lands", async () => {
    const { body } = await call(`/v1/servers/${SERVER}/preview`, { method: "POST", body: "{}" });
    expect(body.estimated_window.measured).toBe(false);
    expect(body.estimated_window.player_visible_ms).toBe("unmeasured");
  });
});
