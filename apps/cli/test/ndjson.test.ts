import { describe, expect, test } from "bun:test";
import { DeploymentState, DeploymentStateEvent, DeploymentStreamRecord } from "@farlands/contracts";
import { Value } from "@sinclair/typebox/value";
import { JsonOutput } from "../src/output/json.ts";
import {
  authorisedEnv,
  contractKeys,
  controlCharactersIn,
  ESC,
  keysOf,
  parseNdjson,
  runFarlands,
  SERVER,
  transitionsOf,
  VERSION,
} from "./harness.ts";

/**
 * The machine mode, which is the mode with the hard rules.
 *
 * A single stray escape sequence breaks every consumer of the stream, and the
 * failure is silent at the point it happens and loud somewhere else hours later.
 * So this file parses a full recorded run rather than sampling it, and checks
 * the whole of stdout byte by byte rather than checking that colour was disabled.
 */

/** Every canonical state name, taken from the contract rather than retyped. */
const CANONICAL_STATES = new Set<string>(DeploymentState.anyOf.map((member) => member.const));

describe("--json writes valid NDJSON", () => {
  test("a full watched run parses as one JSON object per line", async () => {
    const run = await runFarlands(
      [
        "deploy",
        SERVER,
        "--version",
        String(VERSION),
        "--watch",
        "--json",
        "--poll-interval-ms",
        "40",
        "--stall-budget-ms",
        "4000",
      ],
      { env: await authorisedEnv(), scenario: "happy", stepMs: 4 },
    );

    expect(run.exitCode).toBe(0);

    const records = parseNdjson(run.stdout);
    expect(records.length).toBeGreaterThan(1);

    const transitions = transitionsOf(records);
    // The recorded run is a walk of the state machine, not a sample of it.
    // The mock walks nine states. Asserting "at least five" let a regression
    // drop four transitions and still pass, so assert the sequence itself.
    expect(transitions.map((record) => record.state)).toEqual([
      "queued",
      "building",
      "staging",
      "presync",
      "freezing",
      "verifying",
      "cutover",
      "draining",
      "idle",
    ]);
    expect(transitions.at(0)?.state).toBe("queued");
    expect(transitions.at(-1)?.state).toBe("idle");
  });

  test("every record in the stream matches a contract type, not just the transitions", async () => {
    // The stream also carries deployment_stalled and deployment_closed. Both
    // used to be declared inside this app, so a consumer parsing the stream got
    // records the contract package did not define. All three are contracted now.
    const run = await runFarlands(
      [
        "deploy",
        SERVER,
        "--version",
        String(VERSION),
        "--watch",
        "--json",
        "--poll-interval-ms",
        "40",
        "--stall-budget-ms",
        "4000",
      ],
      { env: await authorisedEnv(), scenario: "happy", stepMs: 4 },
    );

    const records = parseNdjson(run.stdout);
    expect(records.length).toBeGreaterThan(1);

    for (const record of records) {
      if (!Value.Check(DeploymentStreamRecord, record)) {
        const detail = [...Value.Errors(DeploymentStreamRecord, record)]
          .slice(0, 3)
          .map((error) => `${error.path}: ${error.message}`)
          .join("; ");
        throw new Error(`uncontracted record ${JSON.stringify(record)} (${detail})`);
      }
    }
  });

  test("every transition object matches the contract type exactly", async () => {
    const run = await runFarlands(
      [
        "deploy",
        SERVER,
        "--version",
        String(VERSION),
        "--watch",
        "--json",
        "--poll-interval-ms",
        "40",
        "--stall-budget-ms",
        "4000",
      ],
      { env: await authorisedEnv(), scenario: "happy", stepMs: 4 },
    );

    const transitions = transitionsOf(parseNdjson(run.stdout));
    expect(transitions.length).toBeGreaterThan(0);
    for (const transition of transitions) {
      expect(keysOf(transition)).toEqual(contractKeys(DeploymentStateEvent));
      expect(transition.event).toBe("deployment_state");
      expect(CANONICAL_STATES.has(String(transition.state))).toBe(true);
      expect(typeof transition.deployment_id).toBe("string");
      expect(typeof transition.server_id).toBe("string");
      expect(Number.isNaN(Date.parse(String(transition.ts)))).toBe(false);
    }
  });

  test("state names are the contract's, verbatim, with no friendlier aliases", async () => {
    const run = await runFarlands(
      [
        "deploy",
        SERVER,
        "--version",
        String(VERSION),
        "--watch",
        "--json",
        "--poll-interval-ms",
        "40",
        "--stall-budget-ms",
        "4000",
      ],
      { env: await authorisedEnv(), scenario: "happy", stepMs: 4 },
    );

    const seen = transitionsOf(parseNdjson(run.stdout)).map((record) => String(record.state));
    expect(seen.length).toBeGreaterThan(0);
    for (const state of seen) expect(CANONICAL_STATES.has(state)).toBe(true);

    // The states the mock walks, in the order the state machine defines. No
    // state is emitted twice in a row, because a transition that did not happen
    // is not a transition.
    for (let index = 1; index < seen.length; index++) {
      expect(seen[index]).not.toBe(seen[index - 1]);
    }
  });

  test("one object per transition, never a batched array", async () => {
    const run = await runFarlands(
      [
        "deploy",
        SERVER,
        "--version",
        String(VERSION),
        "--watch",
        "--json",
        "--poll-interval-ms",
        "40",
        "--stall-budget-ms",
        "4000",
      ],
      { env: await authorisedEnv(), scenario: "happy", stepMs: 4 },
    );

    for (const line of run.stdout.split("\n").filter((entry) => entry !== "")) {
      expect(line.startsWith("{")).toBe(true);
      expect(line.startsWith("[")).toBe(false);
      // A record that spans lines would break a reader that splits on newline.
      expect(line.includes("\n")).toBe(false);
    }
  });
});

describe("--json stdout carries no ANSI", () => {
  test("a watched deployment writes no control characters at all", async () => {
    const run = await runFarlands(
      [
        "deploy",
        SERVER,
        "--version",
        String(VERSION),
        "--watch",
        "--json",
        "--poll-interval-ms",
        "40",
        "--stall-budget-ms",
        "4000",
      ],
      { env: await authorisedEnv(), scenario: "happy", stepMs: 4 },
    );

    expect(controlCharactersIn(run.stdout)).toEqual([]);
    expect(run.stdout.includes(ESC)).toBe(false);
  });

  test("listings and telemetry are clean too, not just deployments", async () => {
    for (const argv of [
      ["servers", "list", "--json"],
      ["telemetry", SERVER, "--window", "1h", "--json"],
    ]) {
      const run = await runFarlands(argv);
      expect(run.exitCode).toBe(0);
      expect(controlCharactersIn(run.stdout)).toEqual([]);
      expect(parseNdjson(run.stdout).length).toBeGreaterThan(0);
    }
  });

  test("a refusal on stdout is clean, even though it is the loudest thing the CLI says", async () => {
    const run = await runFarlands(["deploy", SERVER, "--version", String(VERSION), "--json"]);
    expect(run.exitCode).toBe(2);
    expect(controlCharactersIn(run.stdout)).toEqual([]);
  });

  test("human chatter never reaches stdout under --json", async () => {
    const run = await runFarlands(
      [
        "deploy",
        SERVER,
        "--version",
        String(VERSION),
        "--watch",
        "--json",
        "--poll-interval-ms",
        "30",
        "--stall-budget-ms",
        "4000",
      ],
      { env: await authorisedEnv(), scenario: "happy", stepMs: 4, breakEventStream: true },
    );

    // The broken event stream produces warnings. They belong on stderr, and
    // stdout stays parseable regardless.
    expect(run.stderr).toContain("event stream");
    expect(() => parseNdjson(run.stdout)).not.toThrow();
    expect(controlCharactersIn(run.stdout)).toEqual([]);
  });

  test("an escape byte in server-supplied text cannot reach stdout raw", () => {
    // The structural claim, exercised directly: JSON.stringify escapes every
    // code point below U+0020, so a hostile detail string arrives as data.
    const written: string[] = [];
    const port = new JsonOutput(
      (chunk) => written.push(chunk),
      () => undefined,
    );

    const hostile = `${ESC}[2J${ESC}[31mworld copied`;
    port.transition({
      event: "deployment_state",
      deployment_id: "dep_c41",
      server_id: SERVER,
      state: "presync",
      detail: hostile,
      ts: new Date().toISOString(),
    });

    const line = written.join("");
    expect(controlCharactersIn(line)).toEqual([]);
    expect(line.includes(ESC)).toBe(false);
    // Escaped, not dropped: a consumer still reads back exactly what the server
    // sent, it just never reaches a terminal as an instruction.
    const parsed = parseNdjson(line);
    expect(parsed[0]?.detail).toBe(hostile);
  });
});

describe("human mode is the default", () => {
  test("without --json the deployment renders as a table of named steps", async () => {
    const run = await runFarlands(
      [
        "deploy",
        SERVER,
        "--version",
        String(VERSION),
        "--watch",
        "--poll-interval-ms",
        "40",
        "--stall-budget-ms",
        "4000",
      ],
      { env: await authorisedEnv(), scenario: "happy", stepMs: 4 },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("step");
    expect(run.stdout).toContain("elapsed");
    expect(run.stdout).toContain("presync");
    // Colour was asked for, so human mode genuinely emits escapes. That is the
    // half of the pair that makes the --json assertions mean something.
    expect(run.stdout.includes(ESC)).toBe(true);
  });

  test("the rollback command is printed where the owner can see it", async () => {
    const run = await runFarlands(
      [
        "deploy",
        SERVER,
        "--version",
        String(VERSION),
        "--watch",
        "--poll-interval-ms",
        "40",
        "--stall-budget-ms",
        "4000",
      ],
      { env: await authorisedEnv(), scenario: "happy", stepMs: 4 },
    );

    expect(run.stdout).toContain(`farlands rollback ${SERVER}`);
  });
});
