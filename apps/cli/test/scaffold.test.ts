import { expect, test } from "bun:test";
import { TOOL_DEFINITIONS } from "@farlands/contracts";

/**
 * Placeholder so `bun test` has something to run in this workspace.
 *
 * It is not busywork: it proves the workspace resolves @farlands/contracts,
 * which is the one dependency every track shares and the one whose breakage
 * would otherwise surface as a confusing failure inside real tests.
 *
 * Delete this file once the workspace has real tests.
 */

test("the workspace resolves the contracts package", () => {
  expect(TOOL_DEFINITIONS.length).toBeGreaterThan(0);
});
