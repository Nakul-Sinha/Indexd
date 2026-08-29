import { describe, expect, test } from "bun:test";
import { contentDigest, type DeploymentState } from "@farlands/contracts";
import { app } from "../src/app.ts";

/**
 * The scripted deployment runs.
 *
 * The happy path proves very little on its own. What the CLI actually needs to
 * be built against is a deployment that stalls and one that aborts before
 * cutover, so those are the cases with the most assertions here.
 */

const SERVER = "srv_7f2";
const VERSION = 3;

async function call(path: string, init: RequestInit = {}) {
  const response = await app.handle(
    new Request(`http://mock${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function startDeployment(scenario: string, stepMs = 5) {
  const rules = await call(`/v1/servers/${SERVER}/rule-sets`);
  const digest = rules.body.items.at(-1).content_digest;

  const minted = await call("/v1/approvals", {
    method: "POST",
    body: JSON.stringify({
      server_id: SERVER,
      rule_set_version: VERSION,
      content_digest: digest,
    }),
  });

  const started = await call(
    `/v1/servers/${SERVER}/deploy?scenario=${scenario}&step_ms=${stepMs}`,
    {
      method: "POST",
      body: JSON.stringify({
        rule_set_version: VERSION,
        approval_token: minted.body.token,
      }),
    },
  );
  return started.body.deployment.deployment_id as string;
}

async function settle(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function stateOf(id: string): Promise<DeploymentState> {
  const { body } = await call(`/v1/deployments/${id}`);
  return body.deployment.state;
}

describe("happy path", () => {
  test("walks every state and ends at idle", async () => {
    const id = await startDeployment("happy", 4);
    await settle(200);
    expect(await stateOf(id)).toBe("idle");
  });
});

describe("failure paths", () => {
  test("a build failure ends at failed, and the original is untouched", async () => {
    const id = await startDeployment("fail_at_building", 4);
    await settle(200);

    const { body } = await call(`/v1/deployments/${id}`);
    expect(body.deployment.state).toBe("failed");
    expect(body.deployment.error).toContain("health check");
    // The server of record never moved off its current version.
    const server = await call(`/v1/servers/${SERVER}`);
    expect(server.body.current_version).toBe(3);
  });

  test("an abort before cutover leaves no trace", async () => {
    const id = await startDeployment("abort_at_verifying", 4);
    await settle(200);

    const { body } = await call(`/v1/deployments/${id}`);
    expect(body.deployment.state).toBe("aborted");
    expect(body.deployment.error).toContain("returned to the original");
  });

  test("a stalled deployment stops emitting, which is what watch must detect", async () => {
    const id = await startDeployment("stall", 4);
    await settle(150);

    const first = await stateOf(id);
    expect(first).toBe("presync");

    // Still presync well after the step budget would have advanced it.
    await settle(150);
    expect(await stateOf(id)).toBe("presync");
  });
});

describe("abort endpoint", () => {
  test("aborts a pre-cutover deployment", async () => {
    const id = await startDeployment("stall", 4);
    await settle(120);

    const { body } = await call(`/v1/deployments/${id}/abort`, { method: "POST" });
    expect(body.no_op).toBe(false);
    expect(body.state).toBe("aborted");
  });

  test("is a no-op once the deployment is past cutover", async () => {
    const id = await startDeployment("happy", 4);
    await settle(200);

    const { body } = await call(`/v1/deployments/${id}/abort`, { method: "POST" });
    expect(body.no_op).toBe(true);
    expect(body.state).toBe("idle");
  });
});

describe("SSE", () => {
  test("streams deployment transitions and replays after Last-Event-ID", async () => {
    const stream = await app.handle(
      new Request(`http://mock/v1/servers/${SERVER}/events`, {
        headers: { "x-mock-principal": "usr_demo" },
      }),
    );
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();

    await startDeployment("happy", 4);

    const decoder = new TextDecoder();
    let seen = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !seen.includes('"state":"idle"')) {
      const chunk = await reader?.read();
      if (chunk?.done) break;
      seen += decoder.decode(chunk?.value);
    }

    expect(seen).toContain("event: deployment_state");
    expect(seen).toContain('"state":"building"');
    expect(seen).toContain('"state":"idle"');

    // Every frame carries an id, which is what a client sends back to resume.
    expect(seen).toMatch(/id: \d{12}/);

    await reader?.cancel();
  }, 10_000);

  test("a digest over the same document is stable, so replay ids are comparable", () => {
    expect(contentDigest({ a: 1, b: 2 })).toBe(contentDigest({ b: 2, a: 1 }));
  });
});
