import { describe, expect, test } from "bun:test";
import { createToolInvoker } from "../src/dispatch.ts";
import { recordingToolLogger, redactArguments, stderrToolLogger } from "../src/logging.ts";
import { unlimited } from "../src/rate-limit.ts";
import {
  bodyOf,
  callerFor,
  draftLimitedRig,
  OTHER_SERVER,
  OWNED_SERVER,
  OWNER,
  rigFor,
  SEEDED_VERSION,
} from "./support.ts";

/**
 * Every tool call produces one structured log line, whatever happened.
 *
 * The deployments table is the audit log of record for anything that changed a
 * world. This is the other half: a refused call writes no row anywhere else, so
 * without this line there is no way to reconstruct what an agent tried.
 */

describe("one line per call", () => {
  test("a successful read logs caller, arguments and outcome", async () => {
    const { invoker, logger } = rigFor();
    await invoker.call("get_server", { server_id: OWNED_SERVER });

    expect(logger.entries).toHaveLength(1);
    const entry = logger.entries[0];
    expect(entry?.event).toBe("mcp_tool_call");
    expect(entry?.caller).toBe(OWNER);
    expect(entry?.transport).toBe("stdio");
    expect(entry?.tool).toBe("get_server");
    expect(entry?.tool_class).toBe("read");
    expect(entry?.arguments).toEqual({ server_id: OWNED_SERVER });
    expect(entry?.outcome).toBe("ok");
    expect(entry?.code).toBeNull();
    expect(typeof entry?.duration_ms).toBe("number");
    expect(Date.parse(entry?.ts ?? "")).not.toBeNaN();
  });

  test("every tool in a session logs exactly once each", async () => {
    const { invoker, logger } = rigFor();

    await invoker.call("list_servers", {});
    await invoker.call("get_server", { server_id: OWNED_SERVER });
    await invoker.call("get_world_telemetry", { server_id: OWNED_SERVER });
    await invoker.call("deploy_rules", { server_id: OWNED_SERVER, version: SEEDED_VERSION });

    expect(logger.entries).toHaveLength(4);
    expect(logger.entries.map((entry) => entry.tool)).toEqual([
      "list_servers",
      "get_server",
      "get_world_telemetry",
      "deploy_rules",
    ]);
  });

  test("a scoping refusal is logged as a refusal, not as a success", async () => {
    const { invoker, logger } = rigFor();
    await invoker.call("get_server", { server_id: OTHER_SERVER });

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.outcome).toBe("refused");
    expect(logger.entries[0]?.code).toBe("not_found");
  });

  test("an approval refusal is logged with its code", async () => {
    const { invoker, logger } = rigFor();
    await invoker.call("deploy_rules", { server_id: OWNED_SERVER, version: SEEDED_VERSION });

    expect(logger.entries[0]?.outcome).toBe("refused");
    expect(logger.entries[0]?.code).toBe("approval_required");
    expect(logger.entries[0]?.tool_class).toBe("act");
  });

  test("a rate limited draft is logged with its own code", async () => {
    const { invoker, logger } = draftLimitedRig(0);
    await invoker.call("preview_deploy", { server_id: OWNED_SERVER, version: SEEDED_VERSION });

    expect(logger.entries[0]?.outcome).toBe("refused");
    expect(logger.entries[0]?.code).toBe("rate_limited");
    expect(logger.entries[0]?.tool_class).toBe("draft");
  });

  test("a call to a tool that does not exist is still logged", async () => {
    const { invoker, logger } = rigFor();
    const result = await invoker.call("grant_everyone_diamonds", { server_id: OWNED_SERVER });

    expect(result.isError).toBe(true);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.tool).toBe("grant_everyone_diamonds");
    expect(logger.entries[0]?.tool_class).toBe("unknown");
    expect(logger.entries[0]?.code).toBe("unknown_tool");
  });

  test("invalid arguments are logged with what was actually sent", async () => {
    const { invoker, logger } = rigFor();
    await invoker.call("get_server", { server_id: "not-a-server-id" });

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.code).toBe("invalid_arguments");
    expect(logger.entries[0]?.arguments).toEqual({ server_id: "not-a-server-id" });
  });

  test("a failure inside a tool body is one log line and no thrown error", async () => {
    const logger = recordingToolLogger();
    const invoker = createToolInvoker({
      caller: callerFor(OWNER),
      limiter: unlimited,
      logger,
      api: {
        async send() {
          throw new Error("the socket went away");
        },
      },
    });

    const result = await invoker.call("get_server", { server_id: OWNED_SERVER });

    expect(result.isError).toBe(true);
    expect(bodyOf(result).error).toBe("tool_error");
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.outcome).toBe("error");
    expect(logger.entries[0]?.code).toBe("tool_error");
  });
});

describe("credentials never reach the log", () => {
  test("an approval token is recorded as present, not as itself", async () => {
    const { invoker, logger } = rigFor();
    await invoker.call("deploy_rules", {
      server_id: OWNED_SERVER,
      version: SEEDED_VERSION,
      approval_token: "apv_super_secret_value",
    });

    const logged = logger.entries[0]?.arguments ?? {};
    expect(logged.approval_token).toBe("[redacted]");
    expect(JSON.stringify(logged)).not.toContain("super_secret_value");
  });

  test("redaction leaves ordinary arguments alone", () => {
    expect(redactArguments({ server_id: "srv_7f2", version: 4 })).toEqual({
      server_id: "srv_7f2",
      version: 4,
    });
  });

  test("an absent token stays absent rather than becoming a fake one", () => {
    expect(redactArguments({ approval_token: "" }).approval_token).toBe("");
    expect(redactArguments({}).approval_token).toBeUndefined();
  });
});

describe("the default logger writes one JSON line to stderr", () => {
  test("stdout is left alone, because the stdio transport owns it", async () => {
    const lines: string[] = [];
    const invoker = createToolInvoker({
      caller: callerFor(OWNER),
      limiter: unlimited,
      logger: stderrToolLogger((line) => lines.push(line)),
      api: {
        async send() {
          return { status: 200, ok: true, body: { items: [] } };
        },
      },
    });

    await invoker.call("list_servers", {});

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(parsed.event).toBe("mcp_tool_call");
    expect(parsed.tool).toBe("list_servers");
  });
});
