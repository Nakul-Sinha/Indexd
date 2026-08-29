import { describe, expect, test } from "bun:test";
import { ApprovalRequiredRefusal, approvalRequired } from "@farlands/contracts";
import {
  contractKeys,
  currentDigest,
  keysOf,
  MACHINE_TOKEN,
  parseNdjson,
  runFarlands,
  SERVER,
  VERSION,
} from "./harness.ts";

/**
 * The refusal, compared as bytes.
 *
 * The claim under test is not "the CLI refuses". It is that the CLI refuses with
 * the same body as the MCP act tools, byte for byte, from the one constructor in
 * the contracts package. Comparing parsed objects would pass while the wire
 * bytes differed in key order, and key order is exactly what a consumer diffing
 * two surfaces would notice first.
 */

const READ_ONLY_ENV = { FARLANDS_TOKEN: MACHINE_TOKEN, FARLANDS_API: "http://mock" };

async function refusalLine(argv: readonly string[]): Promise<string> {
  const run = await runFarlands([...argv, "--json"], { env: READ_ONLY_ENV });
  expect(run.exitCode).toBe(2);
  const lines = run.stdout.split("\n").filter((line) => line !== "");
  expect(lines.length).toBe(1);
  const only = lines[0];
  if (only === undefined) throw new Error("no refusal was written to stdout");
  return only;
}

describe("deploy without an approval token", () => {
  test("is the exact body approvalRequired() produces", async () => {
    const line = await refusalLine(["deploy", SERVER, "--version", String(VERSION)]);

    const expected = JSON.stringify(
      approvalRequired({
        reason: "missing",
        tool: "deploy_rules",
        server_id: SERVER,
        rule_set_version: VERSION,
        content_digest: await currentDigest(),
      }),
    );

    expect(Buffer.from(line, "utf8").equals(Buffer.from(expected, "utf8"))).toBe(true);
  });

  test("names the deploy_rules tool, so the two surfaces are comparable", async () => {
    const line = await refusalLine(["deploy", SERVER, "--version", String(VERSION)]);
    const parsed = parseNdjson(line)[0];
    expect(parsed?.error).toBe("approval_required");
    expect(parsed?.reason).toBe("missing");
    expect(parsed?.tool).toBe("deploy_rules");
    expect(keysOf(parsed)).toEqual(contractKeys(ApprovalRequiredRefusal));
  });

  test("changes nothing: no deployment is created", async () => {
    const before = await runFarlands(["servers", "list", "--json"], { env: READ_ONLY_ENV });
    await refusalLine(["deploy", SERVER, "--version", String(VERSION)]);
    const after = await runFarlands(["servers", "list", "--json"], { env: READ_ONLY_ENV });

    // The server of record never moved, and the refusal was not a side effect
    // with a message attached.
    expect(after.stdout).toBe(before.stdout);
  });
});

describe("rollback without an approval token", () => {
  test("is the exact body approvalRequired() produces", async () => {
    const line = await refusalLine(["rollback", SERVER]);

    const expected = JSON.stringify(
      approvalRequired({
        reason: "missing",
        tool: "rollback",
        server_id: SERVER,
        rule_set_version: VERSION,
        content_digest: await currentDigest(),
      }),
    );

    expect(Buffer.from(line, "utf8").equals(Buffer.from(expected, "utf8"))).toBe(true);
  });

  test("gates exactly like deploy, and says so with the rollback tool name", async () => {
    const line = await refusalLine(["rollback", SERVER]);
    const parsed = parseNdjson(line)[0];
    expect(parsed?.tool).toBe("rollback");
    expect(keysOf(parsed)).toEqual(contractKeys(ApprovalRequiredRefusal));
  });
});

describe("the refusal tells the caller what to do", () => {
  test("it points at a human and never at a retry", async () => {
    const line = await refusalLine(["deploy", SERVER, "--version", String(VERSION)]);
    const parsed = parseNdjson(line)[0];
    const resolution = String(parsed?.resolution);
    expect(resolution).toContain("owner");
    expect(resolution.toLowerCase()).not.toContain("try again");
  });

  test("human mode renders it readably and still exits 2", async () => {
    const run = await runFarlands(["deploy", SERVER, "--version", String(VERSION)], {
      env: READ_ONLY_ENV,
    });
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toContain("refused");
    expect(run.stdout).toContain("what to do");
  });
});

describe("a refusal from the server is relayed, not re-authored", () => {
  test("a spent token produces the API's own refusal body", async () => {
    // A token consumed by one deployment is spent, including for a retry. The
    // CLI has a token here, so it makes the call and renders what came back.
    const { authorisedEnv } = await import("./harness.ts");
    const env = await authorisedEnv();

    const first = await runFarlands(["deploy", SERVER, "--version", String(VERSION), "--json"], {
      env,
      scenario: "happy",
      stepMs: 4,
    });
    expect(first.exitCode).toBe(0);

    const second = await runFarlands(["deploy", SERVER, "--version", String(VERSION), "--json"], {
      env,
      scenario: "happy",
      stepMs: 4,
    });
    expect(second.exitCode).toBe(2);

    const parsed = parseNdjson(second.stdout).at(-1);
    expect(parsed?.error).toBe("approval_required");
    expect(parsed?.reason).toBe("consumed");
    expect(keysOf(parsed)).toEqual(contractKeys(ApprovalRequiredRefusal));
  });
});
