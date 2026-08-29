#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { runCli } from "./cli.ts";

/**
 * The farlands binary.
 *
 * The entry point is the only file in the CLI that touches a process handle. It
 * resolves the real world once and hands it to runCli(): the two output sinks,
 * the environment, fetch, the filesystem read used for a token file, and the
 * clock. Everything below this line is testable without a terminal, a port, or a
 * spawned process, and nothing below this line can reach stdout except through
 * the output port chosen in runCli().
 */

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const exitCode = await runCli(process.argv.slice(2), {
  stdout: (chunk) => process.stdout.write(chunk),
  stderr: (chunk) => process.stderr.write(chunk),
  env: process.env,
  fetch: (request) => globalThis.fetch(request),
  readTextFile,
  homeDir: homedir(),
});

process.exitCode = exitCode;
