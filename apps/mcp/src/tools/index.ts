import type { ToolName } from "@farlands/contracts";
import { assertToolSurface } from "../schema.ts";
import { actTools } from "./act.ts";
import type { ToolHandler } from "./context.ts";
import { draftTools } from "./draft.ts";
import { readTools } from "./read.ts";

/**
 * The implementation registry, keyed by the contract's tool names.
 *
 * The `Record<ToolName, ToolHandler>` annotation makes a missing or misspelled
 * tool a compile error. The runtime assertion below covers what the type cannot:
 * a registry assembled at run time, and the reverse direction, an implementation
 * that no definition names. The assertion runs at module load rather than on
 * first call, so drift cannot get as far as a demo.
 */
export const TOOL_IMPLEMENTATIONS: Record<ToolName, ToolHandler> = {
  ...readTools,
  ...draftTools,
  ...actTools,
};

assertToolSurface(Object.keys(TOOL_IMPLEMENTATIONS));

export type { ToolContext, ToolHandler } from "./context.ts";
export { actTools, draftTools, readTools };
