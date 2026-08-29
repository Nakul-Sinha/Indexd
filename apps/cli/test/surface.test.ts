import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { jsonRequested } from "../src/output/index.ts";
import { controlCharactersIn, MACHINE_TOKEN, parseNdjson, runFarlands, SERVER } from "./harness.ts";

/**
 * The command surface, and the structure that keeps the two output modes apart.
 *
 * The structural checks are the point of the file. The --json rule is enforced
 * by what a command body can reach, not by a habit of remembering it, so these
 * assert on the shape of the module graph: only one module imports a colour
 * helper, and only the entry point holds a process handle. Both would still be
 * true if every behavioural test were deleted, and both would fail the moment
 * somebody added a spinner to a command.
 */

const SOURCE_ROOT = join(import.meta.dir, "..", "src");
const READ_ONLY_ENV = { FARLANDS_TOKEN: MACHINE_TOKEN, FARLANDS_API: "http://mock" };

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) found.push(path);
  }
  return found;
}

function posixPath(file: string): string {
  return relative(SOURCE_ROOT, file).split("\\").join("/");
}

describe("the NDJSON rule is structural", () => {
  test("only the human renderer imports a colour helper", () => {
    const importers = sourceFiles(SOURCE_ROOT)
      .filter((file) => /from "picocolors"/.test(readFileSync(file, "utf8")))
      .map(posixPath);

    expect(importers).toEqual(["output/human.ts"]);
  });

  test("only the entry point touches a process output handle", () => {
    const holders = sourceFiles(SOURCE_ROOT)
      .filter((file) => /process\.(?:stdout|stderr)/.test(readFileSync(file, "utf8")))
      .map(posixPath);

    // Everything else writes through the injected sinks, which is what makes a
    // stray write impossible rather than merely discouraged.
    expect(holders).toEqual(["index.ts"]);
  });

  test("the machine renderer serializes, and never formats", () => {
    const source = readFileSync(join(SOURCE_ROOT, "output", "json.ts"), "utf8");
    // One writer, and it stringifies. A method that took a pre-rendered string
    // would be the hole the whole design exists to close.
    expect(source.match(/this\.stdout\(/g)?.length).toBe(1);
    expect(source).toContain("JSON.stringify");
  });

  test("the mode is decided once, from raw argv", () => {
    expect(jsonRequested(["deploy", "srv_7f2", "--json"])).toBe(true);
    expect(jsonRequested(["--json", "servers", "list"])).toBe(true);
    expect(jsonRequested(["servers", "list"])).toBe(false);
    expect(jsonRequested(["servers", "list", "--json=false"])).toBe(false);
    // After the separator, arguments belong to somebody else.
    expect(jsonRequested(["logs", "srv_7f2", "--", "--json"])).toBe(false);
  });
});

describe("the command surface", () => {
  test("servers list renders both ways", async () => {
    const human = await runFarlands(["servers", "list"], { env: READ_ONLY_ENV });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain(SERVER);
    expect(human.stdout).toContain("players");

    const machine = await runFarlands(["servers", "list", "--json"], { env: READ_ONLY_ENV });
    const records = parseNdjson(machine.stdout);
    expect(records.every((record) => record.event === "server")).toBe(true);
    expect(records.map((record) => record.server_id)).toContain(SERVER);
  });

  test("servers list is scoped: it shows only what the token can see", async () => {
    const run = await runFarlands(["servers", "list", "--json"], { env: READ_ONLY_ENV });
    const ids = parseNdjson(run.stdout).map((record) => record.server_id);
    // srv_a19 exists in the mock and belongs to somebody else.
    expect(ids).not.toContain("srv_a19");
  });

  test("telemetry reports a window of aggregates", async () => {
    const run = await runFarlands(["telemetry", SERVER, "--window", "1h", "--json"], {
      env: READ_ONLY_ENV,
    });
    expect(run.exitCode).toBe(0);

    const record = parseNdjson(run.stdout)[0];
    expect(record?.event).toBe("world_activity");
    expect(record?.window).toBe("1h");
    expect(record).toHaveProperty("metrics");
  });

  test("telemetry rejects a window the contract does not define", async () => {
    const run = await runFarlands(["telemetry", SERVER, "--window", "3d"], {
      env: READ_ONLY_ENV,
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("window");
  });

  test("telemetry for a server you do not own is refused, not returned empty", async () => {
    const run = await runFarlands(["telemetry", "srv_a19", "--json"], { env: READ_ONLY_ENV });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("404");
  });

  test("deploy names the versions that exist when asked for one that does not", async () => {
    const run = await runFarlands(["deploy", SERVER, "--version", "99"], { env: READ_ONLY_ENV });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("no rule set version 99");
    expect(run.stderr).toContain("Versions on this server");
  });

  test("logs drains the stream and stops when it goes quiet", async () => {
    const run = await runFarlands(["logs", SERVER, "--idle-timeout-ms", "60", "--json"], {
      env: READ_ONLY_ENV,
    });
    // The mock publishes no console lines, so the interesting property is that
    // the command terminates and writes nothing rather than hanging.
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
  }, 15_000);

  test("rules author reports the missing endpoint plainly", async () => {
    // The mock does not serve POST /v1/servers/:id/rule-sets/author yet. The
    // property worth asserting now is that an absent endpoint is a clean error
    // with the route in it, not a stack trace or a half-written stream.
    const run = await runFarlands(["rules", "author", SERVER, "fewer zombies near spawn"], {
      env: READ_ONLY_ENV,
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("rule-sets/author");
    expect(run.stdout).toBe("");
  });

  test("an unknown command exits non-zero and prints usage to stderr", async () => {
    const run = await runFarlands(["teleport", SERVER, "--json"], { env: READ_ONLY_ENV });
    expect(run.exitCode).toBe(1);
    // Usage is coloured by citty, so it must never land on stdout under --json.
    expect(run.stdout).toBe("");
    expect(controlCharactersIn(run.stdout)).toEqual([]);
    expect(run.stderr).toContain("teleport");
  });

  test("the whole documented surface is reachable", async () => {
    // The command list from the specification, checked by asking each one for
    // its own usage. A command that was renamed or dropped fails here rather
    // than in whatever script was calling it.
    for (const argv of [
      ["servers", "list"],
      ["rules", "author"],
      ["deploy"],
      ["rollback"],
      ["telemetry"],
      ["logs"],
    ]) {
      const run = await runFarlands([...argv, "--help"], { env: READ_ONLY_ENV });
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain(String(argv.at(-1)));
      expect(run.stdout).toContain("USAGE");
    }
  });

  test("help for a subcommand describes that subcommand, not the root", async () => {
    const run = await runFarlands(["deploy", "--help"], { env: READ_ONLY_ENV });
    expect(run.stdout).toContain("--watch");
    expect(run.stdout).toContain("--on-stall");
    expect(run.stdout).not.toContain("Aggregated world activity");
  });

  test("help goes to stderr under --json, so stdout stays a stream", async () => {
    const run = await runFarlands(["deploy", "--help", "--json"], { env: READ_ONLY_ENV });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("--watch");
  });
});
