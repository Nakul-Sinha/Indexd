import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TOKEN_PREFIX } from "@farlands/contracts";
import {
  APPROVAL_TOKEN_ENV,
  BASE_URL_ENV,
  CONFIG_PATH_ENV,
  MACHINE_TOKEN_ENV,
  MACHINE_TOKEN_FILE_ENV,
  resolveMachineToken,
} from "../src/auth.ts";
import { MACHINE_TOKEN, runFarlands, SERVER } from "./harness.ts";

/**
 * Authentication is a machine token. That is the rule with no exception, and
 * this file is the assertion the rule asked for.
 *
 * Two halves, because either alone is weak. The behavioural half proves a
 * password in the environment is ignored and a bad prefix is rejected. The
 * structural half reads every source file and proves there is no interactive
 * input path at all, which is the thing a behavioural test cannot see: a prompt
 * that only fires on a TTY looks like dead code to a test and like a password
 * box to a user.
 */

const SOURCE_ROOT = join(import.meta.dir, "..", "src");

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) found.push(path);
  }
  return found;
}

/**
 * Comments and string literals are stripped before matching.
 *
 * Without this, the file that explains why there is no password prompt is the
 * file that fails the check, which punishes documenting the rule.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""');
}

/** Anything that could read a secret from a person at the terminal. */
const INTERACTIVE_INPUT = [
  /\breadline\b/,
  /\bcreateInterface\b/,
  /\bprocess\.stdin\b/,
  /\bBun\.stdin\b/,
  /\bprompt\s*\(/,
  /\bpromptForPassword\b/,
  /\bgetPassword\b/,
  /\bgetpass\b/,
  /\binquirer\b/,
  /\benquirer\b/,
  /\bpassword\b/i,
  /\bpasswd\b/i,
  /\bcredentialsPrompt\b/,
];

describe("there is no password anywhere in the binary", () => {
  test("no source file contains an interactive input or password path", () => {
    const offences: string[] = [];
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const code = codeOnly(readFileSync(file, "utf8"));
      for (const pattern of INTERACTIVE_INPUT) {
        if (pattern.test(code)) offences.push(`${file} matches ${pattern}`);
      }
    }
    expect(offences).toEqual([]);
  });

  test("no prompt library is declared as a dependency", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });

    // A prompt library in the manifest is a prompt one import away. citty and
    // picocolors are an argument parser and a colour helper; neither reads stdin.
    for (const name of declared) {
      expect(/prompt|inquirer|enquirer|password|passwd|readline/i.test(name)).toBe(false);
    }
  });

  test("there is no login command in the surface", async () => {
    const run = await runFarlands(["login"]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("login");
  });

  test("the credential sources the CLI reads are all token sources", () => {
    const names = [
      MACHINE_TOKEN_ENV,
      MACHINE_TOKEN_FILE_ENV,
      APPROVAL_TOKEN_ENV,
      CONFIG_PATH_ENV,
      BASE_URL_ENV,
    ];
    for (const name of names) {
      expect(/pass|pwd|secret|login/i.test(name)).toBe(false);
    }
  });
});

describe("a machine token, or a clear refusal to proceed", () => {
  test("a password in the environment is not a credential", async () => {
    const run = await runFarlands(["servers", "list"], {
      env: {
        FARLANDS_API: "http://mock",
        FARLANDS_PASSWORD: "hunter2",
        FARLANDS_USER: "someone",
      },
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("No machine token configured");
    expect(run.stderr).toContain("never asks for a password");
    expect(run.stdout).toBe("");
  });

  test("an approval token is rejected where a machine token belongs", () => {
    expect(() =>
      resolveMachineToken({
        env: { [MACHINE_TOKEN_ENV]: `${TOKEN_PREFIX.approval}whatever` },
        readTextFile: () => null,
        homeDir: null,
      }),
    ).toThrow(/approval token, not a machine token/);
  });

  test("anything without the machine prefix is rejected", () => {
    expect(() =>
      resolveMachineToken({
        env: { [MACHINE_TOKEN_ENV]: "hunter2" },
        readTextFile: () => null,
        homeDir: null,
      }),
    ).toThrow(/does not hold a machine token/);
  });

  test("a token file is accepted, so CI can mount a secret rather than export one", () => {
    const credential = resolveMachineToken({
      env: { [MACHINE_TOKEN_FILE_ENV]: "/run/secrets/farlands" },
      readTextFile: (path) => (path === "/run/secrets/farlands" ? `${MACHINE_TOKEN}\n` : null),
      homeDir: null,
    });
    expect(credential?.token).toBe(MACHINE_TOKEN);
  });

  test("a config file is accepted, and only its token field is read", () => {
    const credential = resolveMachineToken({
      env: {},
      readTextFile: (path) =>
        path === "/home/dev/.config/farlands/config.json"
          ? JSON.stringify({ api: "http://mock", token: MACHINE_TOKEN, password: "hunter2" })
          : null,
      homeDir: "/home/dev",
    });
    expect(credential?.token).toBe(MACHINE_TOKEN);
  });

  test("no credentials at all is null, not a prompt", () => {
    const credential = resolveMachineToken({ env: {}, readTextFile: () => null, homeDir: null });
    expect(credential).toBeNull();
  });
});

describe("tokens are never passed on the command line", () => {
  test("no command declares a token flag", async () => {
    for (const argv of [
      ["deploy", SERVER, "--version", "3", "--token", MACHINE_TOKEN],
      ["rollback", SERVER, "--approval-token", "apv_whatever"],
    ]) {
      // An argument vector is readable by every process on the machine, so the
      // flags do not exist. Passing them changes nothing: the command still
      // resolves credentials from the environment and finds none.
      const run = await runFarlands(argv, { env: { FARLANDS_API: "http://mock" } });
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("No machine token configured");
    }
  });
});
