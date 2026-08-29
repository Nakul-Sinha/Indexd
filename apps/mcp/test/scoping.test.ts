import { describe, expect, test } from "bun:test";
import {
  bodyOf,
  matchesContract,
  OTHER,
  OTHER_SERVER,
  OWNED_SERVER,
  OWNER,
  rigFor,
} from "./support.ts";

/**
 * Read scoping, driven against the mock API in process.
 *
 * The claim being tested is narrow and specific: a caller reading someone else's
 * server gets a refusal, not an empty result. Empty leaks existence, and
 * `get_world_telemetry` makes existence a question about named players.
 */

describe("caller A reading caller B's server", () => {
  test("get_server is refused rather than answered", async () => {
    const { invoker } = rigFor(OWNER);
    const result = await invoker.call("get_server", { server_id: OTHER_SERVER });
    const body = bodyOf(result);

    expect(result.isError).toBe(true);
    expect(body.error).toBe("not_found");
    expect(matchesContract("NotFoundRefusal", body)).toBe(true);
  });

  test("get_world_telemetry is refused rather than answered", async () => {
    const { invoker } = rigFor(OWNER);
    const result = await invoker.call("get_world_telemetry", {
      server_id: OTHER_SERVER,
      window: "1h",
    });
    const body = bodyOf(result);

    expect(result.isError).toBe(true);
    expect(body.error).toBe("not_found");
    expect(matchesContract("NotFoundRefusal", body)).toBe(true);
  });

  test("the refusal carries no data about the server it refused", async () => {
    const { invoker } = rigFor(OWNER);
    const body = bodyOf(await invoker.call("get_server", { server_id: OTHER_SERVER }));

    for (const leaked of ["hostname", "player_count", "tps", "state", "metrics", "regions"]) {
      expect(body).not.toHaveProperty(leaked);
    }
  });

  test("an empty result is never substituted for the refusal", async () => {
    const { invoker } = rigFor(OWNER);
    const telemetry = bodyOf(
      await invoker.call("get_world_telemetry", { server_id: OTHER_SERVER, window: "1h" }),
    );
    expect(telemetry.metrics).toBeUndefined();
    expect(telemetry.error).toBe("not_found");
  });

  test("rule set history and diffs are scoped the same way", async () => {
    const { invoker } = rigFor(OWNER);

    const list = bodyOf(await invoker.call("list_rule_sets", { server_id: OTHER_SERVER }));
    expect(list.error).toBe("not_found");

    const single = bodyOf(
      await invoker.call("get_rule_set", { server_id: OTHER_SERVER, version: 1 }),
    );
    expect(single.error).toBe("not_found");

    const diff = bodyOf(
      await invoker.call("diff_rule_sets", {
        server_id: OTHER_SERVER,
        from_version: 1,
        to_version: 2,
      }),
    );
    expect(diff.error).toBe("not_found");
  });

  test("scoping holds in the other direction too", async () => {
    const { invoker } = rigFor(OTHER);
    const body = bodyOf(await invoker.call("get_server", { server_id: OWNED_SERVER }));
    expect(body.error).toBe("not_found");
  });
});

describe("a caller reading their own server", () => {
  test("gets the server", async () => {
    const { invoker } = rigFor(OWNER);
    const result = await invoker.call("get_server", { server_id: OWNED_SERVER });
    const body = bodyOf(result);

    expect(result.isError).toBe(false);
    expect(body.server_id).toBe(OWNED_SERVER);
  });

  test("list_servers shows only their own", async () => {
    const { invoker } = rigFor(OWNER);
    const body = bodyOf(await invoker.call("list_servers", {}));
    const servers = body.servers as Array<{ server_id: string }>;

    expect(servers.map((server) => server.server_id)).toEqual([OWNED_SERVER]);
  });

  test("list_servers for the other tenant shows only theirs", async () => {
    const { invoker } = rigFor(OTHER);
    const body = bodyOf(await invoker.call("list_servers", {}));
    const servers = body.servers as Array<{ server_id: string }>;

    expect(servers.map((server) => server.server_id)).toEqual([OTHER_SERVER]);
  });
});

describe("telemetry returns rollups and nothing else", () => {
  test("rolling window metrics, never an event list", async () => {
    const { invoker } = rigFor(OWNER);
    const body = bodyOf(
      await invoker.call("get_world_telemetry", { server_id: OWNED_SERVER, window: "1h" }),
    );

    expect(body).toHaveProperty("metrics");
    expect(body).not.toHaveProperty("events");
    expect(JSON.stringify(body)).not.toContain("player_name");
  });

  test("the window defaults to the value the contract declares", async () => {
    const { invoker } = rigFor(OWNER);
    const body = bodyOf(await invoker.call("get_world_telemetry", { server_id: OWNED_SERVER }));
    expect(body.window).toBe("1h");
  });

  test("the response repeats that this is personal data", async () => {
    const { invoker } = rigFor(OWNER);
    const body = bodyOf(
      await invoker.call("get_world_telemetry", { server_id: OWNED_SERVER, window: "24h" }),
    );
    expect(String(body.notice)).toContain("behavioural record of named players");
  });
});
