import { describe, expect, test } from "bun:test";
import { contentDigest } from "@farlands/contracts";
import { deployments } from "../../../tools/mock-api/src/state.ts";
import { createToolInvoker } from "../src/dispatch.ts";
import { recordingToolLogger } from "../src/logging.ts";
import { unlimited } from "../src/rate-limit.ts";
import {
  bodyOf,
  callerFor,
  callMock,
  matchesContract,
  mintApproval,
  OTHER_SERVER,
  OWNED_SERVER,
  OWNER,
  rigFor,
  SEEDED_VERSION,
} from "./support.ts";

/**
 * Act tools fail closed, in all five approval failure modes.
 *
 * "Fails closed" is a claim that needs every mode to be true and not just the
 * obvious one, so each is exercised end to end against the mock API and each
 * asserts the same two things: the structured refusal came back, and no
 * deployment row appeared.
 */

async function deployWith(token: string | undefined) {
  const { invoker } = rigFor();
  const before = deployments.size;
  const result = await invoker.call("deploy_rules", {
    server_id: OWNED_SERVER,
    version: SEEDED_VERSION,
    ...(token === undefined ? {} : { approval_token: token }),
  });
  return { result, body: bodyOf(result), before, after: deployments.size };
}

describe("deploy_rules refuses and changes nothing", () => {
  test("with no token at all", async () => {
    const { result, body, before, after } = await deployWith(undefined);

    expect(result.isError).toBe(true);
    expect(body.error).toBe("approval_required");
    expect(body.reason).toBe("missing");
    expect(after).toBe(before);
  });

  test("with a token that was never minted", async () => {
    const { body, before, after } = await deployWith("apv_never_existed");

    expect(body.error).toBe("approval_required");
    expect(body.reason).toBe("missing");
    expect(after).toBe(before);
  });

  test("with an expired token", async () => {
    const token = await mintApproval({ ttl_seconds: -1 });
    const { body, before, after } = await deployWith(token);

    expect(body.reason).toBe("expired");
    expect(after).toBe(before);
  });

  test("with a token already spent", async () => {
    const token = await mintApproval();

    const first = await deployWith(token);
    expect(first.result.isError).toBe(false);
    expect(first.after).toBe(first.before + 1);

    const second = await deployWith(token);
    expect(second.body.reason).toBe("consumed");
    expect(second.after).toBe(second.before);
  });

  test("with a token issued to a different principal", async () => {
    const token = await mintApproval({ issued_to: "usr_someone_else" });
    const { body, before, after } = await deployWith(token);

    expect(body.reason).toBe("principal_mismatch");
    expect(after).toBe(before);
  });

  test("with a token minted against different content", async () => {
    // Time of check against time of use: approve one document, then try to
    // deploy something else under the same version claim.
    const token = await mintApproval({ content_digest: contentDigest({ something: "else" }) });
    const { body, before, after } = await deployWith(token);

    expect(body.reason).toBe("digest_mismatch");
    expect(after).toBe(before);
  });
});

describe("the refusal is the contract's refusal", () => {
  test("it matches the committed ApprovalRequiredRefusal schema", async () => {
    const { body } = await deployWith(undefined);
    expect(matchesContract("ApprovalRequiredRefusal", body)).toBe(true);
  });

  test("it is byte for byte what the deploy endpoint returned", async () => {
    const direct = await callMock(`/v1/servers/${OWNED_SERVER}/deploy`, {
      method: "POST",
      body: JSON.stringify({ rule_set_version: SEEDED_VERSION }),
    });
    const { body } = await deployWith(undefined);

    expect(direct.status).toBe(403);
    expect(JSON.stringify(body)).toBe(JSON.stringify(direct.body));
  });

  test("it names the digest the approval must be minted against", async () => {
    const { body } = await deployWith(undefined);
    expect(String(body.content_digest)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(String(body.message)).toContain(OWNED_SERVER);
  });

  test("it tells the caller to ask a human, never to retry", async () => {
    const { body } = await deployWith(undefined);
    const resolution = String(body.resolution).toLowerCase();

    expect(resolution).toContain("owner");
    expect(resolution).not.toContain("try again");
    expect(resolution).not.toContain("retry this");
  });

  test("it arrives as tool content rather than as a thrown error", async () => {
    const { result } = await deployWith(undefined);
    const first = result.content[0] as { type: string; text: string };

    expect(first.type).toBe("text");
    expect(first.text).toContain("approval_required");
    expect(first.text).toContain("Ask the server owner");
  });
});

describe("the other act tools fail closed too", () => {
  test("rollback without a token changes nothing", async () => {
    const { invoker } = rigFor();
    const before = deployments.size;
    const result = await invoker.call("rollback", { server_id: OWNED_SERVER });
    const body = bodyOf(result);

    expect(result.isError).toBe(true);
    expect(body.error).not.toBe(undefined);
    expect(deployments.size).toBe(before);
  });

  test("power_action without a token changes nothing", async () => {
    const { invoker } = rigFor();
    const result = await invoker.call("power_action", {
      server_id: OWNED_SERVER,
      action: "stop",
    });

    expect(result.isError).toBe(true);
  });

  test("create_server without a token changes nothing", async () => {
    const { invoker } = rigFor();
    const result = await invoker.call("create_server", { name: "brand-new" });

    expect(result.isError).toBe(true);
  });

  test("an act tool on a server the caller does not own is refused", async () => {
    const { invoker } = rigFor();
    const body = bodyOf(
      await invoker.call("deploy_rules", { server_id: OTHER_SERVER, version: 1 }),
    );

    expect(body.error).toBe("not_found");
  });

  test("an unreachable API is a refusal to act, not a stack trace", async () => {
    // A token that looks perfectly good still deploys nothing when the API
    // cannot be reached, because only the API can say the token is good.
    const offline = createToolInvoker({
      caller: callerFor(OWNER),
      api: {
        async send() {
          return { status: 0, ok: false, body: { error: "upstream_unreachable" } };
        },
      },
      limiter: unlimited,
      logger: recordingToolLogger(),
    });

    const result = await offline.call("deploy_rules", {
      server_id: OWNED_SERVER,
      version: SEEDED_VERSION,
      approval_token: "apv_looks_fine",
    });
    const body = bodyOf(result);

    expect(result.isError).toBe(true);
    expect(body.error).toBe("upstream_unreachable");
    expect(String(body.message)).toContain("nothing was attempted");
  });
});
