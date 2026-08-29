import { describe, expect, test } from "bun:test";
import {
  requiresApproval,
  TOOL_DEFINITIONS,
  TOOLS_BY_CLASS,
  type ToolName,
  toolInputs,
} from "@farlands/contracts";
import { generateToolSchemas } from "../src/schema.ts";
import { SERVER_INSTRUCTIONS } from "../src/server.ts";
import { actTools, draftTools, readTools, TOOL_IMPLEMENTATIONS } from "../src/tools/index.ts";

/**
 * The class boundary is the security boundary, so it is asserted rather than
 * described. Every act tool takes an approval token and no read or draft tool
 * does, which is the property that makes "an agent cannot change a world without
 * a human" a structural claim instead of a promise about the code.
 */

function schemaFor(name: ToolName): Record<string, unknown> {
  return JSON.parse(JSON.stringify(toolInputs[name])) as Record<string, unknown>;
}

function acceptsApprovalToken(name: ToolName): boolean {
  const properties = schemaFor(name).properties as Record<string, unknown> | undefined;
  return properties !== undefined && "approval_token" in properties;
}

describe("the three classes", () => {
  test("cover every tool exactly once", () => {
    const grouped = [...TOOLS_BY_CLASS.read, ...TOOLS_BY_CLASS.draft, ...TOOLS_BY_CLASS.act];
    expect(grouped.length).toBe(TOOL_DEFINITIONS.length);
    expect(new Set(grouped).size).toBe(TOOL_DEFINITIONS.length);
  });

  test("are implemented in the file that owns them", () => {
    expect(Object.keys(readTools).sort()).toEqual([...TOOLS_BY_CLASS.read].sort());
    expect(Object.keys(draftTools).sort()).toEqual([...TOOLS_BY_CLASS.draft].sort());
    expect(Object.keys(actTools).sort()).toEqual([...TOOLS_BY_CLASS.act].sort());
  });

  test("every tool named by the contract has an implementation", () => {
    for (const definition of TOOL_DEFINITIONS) {
      expect(typeof TOOL_IMPLEMENTATIONS[definition.name]).toBe("function");
    }
  });
});

describe("approval is required by exactly the act tools", () => {
  test("every act tool requires approval", () => {
    for (const name of TOOLS_BY_CLASS.act) {
      expect(requiresApproval(name)).toBe(true);
    }
  });

  test("no read or draft tool requires approval", () => {
    for (const name of [...TOOLS_BY_CLASS.read, ...TOOLS_BY_CLASS.draft]) {
      expect(requiresApproval(name)).toBe(false);
    }
  });

  test("every act tool carries an approval token in its schema", () => {
    for (const name of TOOLS_BY_CLASS.act) {
      expect(acceptsApprovalToken(name)).toBe(true);
    }
  });

  test("no read or draft tool has anywhere to put a token", () => {
    for (const name of [...TOOLS_BY_CLASS.read, ...TOOLS_BY_CLASS.draft]) {
      expect(acceptsApprovalToken(name)).toBe(false);
    }
  });
});

describe("the published tool list makes the boundary visible", () => {
  test("each tool carries its class", () => {
    for (const tool of generateToolSchemas()) {
      const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === tool.name);
      expect(tool._meta?.["farlands/class"]).toBe(definition?.class);
    }
  });

  test("read tools are annotated read only and act tools are not", () => {
    for (const tool of generateToolSchemas()) {
      const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === tool.name);
      expect(tool.annotations?.readOnlyHint).toBe(definition?.class === "read");
      if (definition?.class === "act") expect(tool.annotations?.destructiveHint).toBe(true);
      if (definition?.class !== "act") expect(tool.annotations?.destructiveHint).toBe(false);
    }
  });

  test("the act descriptions warn about what rollback does not undo", () => {
    const byName = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool.description]));
    expect(byName.get("create_server")).toContain("not undone by rollback");
    expect(byName.get("power_action")).toContain("disconnects every connected player");
    expect(byName.get("rollback")).toContain("does not undo what the rule already did");
  });

  test("the server instructions state the boundary before any tool is called", () => {
    expect(SERVER_INSTRUCTIONS).toContain("class boundary is the security boundary");
    expect(SERVER_INSTRUCTIONS).toContain("rate_limited response means wait, not ask a human");
    expect(SERVER_INSTRUCTIONS).toContain("never to retry");
  });
});
