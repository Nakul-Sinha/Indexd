/**
 * @farlands/contracts is the locked seam.
 *
 * Four clients and a schema generator read this package: the web app, the phone,
 * the CLI, the MCP server, and the tool-schema build step. A change here changes
 * all of them at once, which is why it lands by pull request reviewed by whoever
 * the type touches, and never incidentally.
 *
 * Ownership, from CONTEXT.md section 13: Engineer 3 is the scribe. Engineer 2
 * authors the deployment state union. Engineer 1 authors the tool surface, the
 * refusal, the telemetry shapes and the proposal shapes. All of it is hosted
 * here so nobody imports a type from someone else's application code.
 */

export * from "./api.ts";
export * from "./common.ts";
export * from "./deployment.ts";
export * from "./digest.ts";
export * from "./events.ts";
export * from "./mcp-tools.ts";
export * from "./proposals.ts";
export * from "./refusal.ts";
/**
 * Provisional exports. These are stand-ins for the lifted plugin-builder and
 * are deleted at Phase 0 when the real vocabulary arrives. They are exported
 * under explicit names so every consumer of a stand-in is greppable in one
 * command: rg "provisional".
 */
export * as provisionalVocabulary from "./rule-document.provisional.ts";
export * from "./rules.ts";
export * from "./telemetry.ts";
export * as provisionalValidation from "./validation.provisional.ts";
