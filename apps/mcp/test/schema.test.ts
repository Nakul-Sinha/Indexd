import { describe, expect, test } from "bun:test";
import { TOOL_DEFINITIONS, type ToolName, toolInputs } from "@farlands/contracts";
import {
  assertToolSurface,
  generateToolSchemas,
  ToolSurfaceDriftError,
  toolSurfaceDrift,
  validateToolArguments,
} from "../src/schema.ts";
import { TOOL_IMPLEMENTATIONS } from "../src/tools/index.ts";
import { readToolManifest } from "./support.ts";

/**
 * The tool surface is generated, and it cannot drift from the contract.
 *
 * Two claims are proved here. The published schema is the contract type rather
 * than a copy of it, and a definition and an implementation that disagree fail
 * a test rather than shipping.
 */

describe("tool schemas are generated from the contracts package", () => {
  test("one tool per definition, in contract order", () => {
    const generated = generateToolSchemas();
    expect(generated.map((tool) => tool.name)).toEqual(TOOL_DEFINITIONS.map((tool) => tool.name));
    expect(generated).toHaveLength(13);
  });

  test("every input schema is the contract type, serialized", () => {
    for (const tool of generateToolSchemas()) {
      const contract = toolInputs[tool.name as ToolName];
      expect(JSON.stringify(tool.inputSchema)).toBe(JSON.stringify(contract));
    }
  });

  test("descriptions come from the contract, never from this package", () => {
    for (const tool of generateToolSchemas()) {
      const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === tool.name);
      expect(tool.description).toBe(definition?.description);
    }
  });

  test("what tools/list publishes equals the manifest the contracts package commits", () => {
    const manifest = readToolManifest();
    const generated = generateToolSchemas();
    expect(generated).toHaveLength(manifest.length);

    for (const [index, entry] of manifest.entries()) {
      const tool = generated[index];
      expect(tool?.name).toBe(entry.name);
      expect(tool?.description).toBe(entry.description);
      expect(JSON.stringify(tool?.inputSchema)).toBe(JSON.stringify(entry.inputSchema));
      expect(tool?._meta?.["farlands/class"]).toBe(entry.class);
    }
  });

  test("the telemetry tool says out loud that it is a record of named players", () => {
    const telemetry = generateToolSchemas().find((tool) => tool.name === "get_world_telemetry");
    expect(telemetry?.description).toContain("behavioural record of named players");
    expect(telemetry?.description).toContain("never raw events");
  });
});

describe("the drift check", () => {
  test("passes for the real registry", () => {
    const drift = toolSurfaceDrift(Object.keys(TOOL_IMPLEMENTATIONS));
    expect(drift.missing).toEqual([]);
    expect(drift.unexpected).toEqual([]);
    expect(() => {
      assertToolSurface(Object.keys(TOOL_IMPLEMENTATIONS));
    }).not.toThrow();
  });

  test("fails when a definition has no implementation", () => {
    const short = Object.keys(TOOL_IMPLEMENTATIONS).filter((name) => name !== "deploy_rules");
    expect(toolSurfaceDrift(short).missing).toEqual(["deploy_rules"]);
    expect(() => {
      assertToolSurface(short);
    }).toThrow(ToolSurfaceDriftError);
  });

  test("fails when an implementation has no definition", () => {
    const extra = [...Object.keys(TOOL_IMPLEMENTATIONS), "grant_everyone_diamonds"];
    expect(toolSurfaceDrift(extra).unexpected).toEqual(["grant_everyone_diamonds"]);
    expect(() => {
      assertToolSurface(extra);
    }).toThrow(/not in TOOL_DEFINITIONS/);
  });

  test("reports both directions at once", () => {
    const drift = toolSurfaceDrift(["get_server", "invented_tool"]);
    expect(drift.missing).toContain("deploy_rules");
    expect(drift.unexpected).toEqual(["invented_tool"]);
  });
});

describe("arguments are validated server side against the same schema", () => {
  test("accepts arguments the contract describes", () => {
    const check = validateToolArguments("get_server", { server_id: "srv_7f2" });
    expect(check.ok).toBe(true);
  });

  test("rejects a missing required argument", () => {
    const check = validateToolArguments("get_server", {});
    expect(check.ok).toBe(false);
  });

  test("rejects a value the contract pattern forbids", () => {
    const check = validateToolArguments("get_server", { server_id: "not-a-server-id" });
    expect(check.ok).toBe(false);
  });

  test("rejects an argument the contract does not define rather than ignoring it", () => {
    const check = validateToolArguments("get_server", {
      server_id: "srv_7f2",
      also_delete_everything: true,
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toContain("also_delete_everything");
  });

  test("fills in a default the contract declares", () => {
    const check = validateToolArguments("get_world_telemetry", { server_id: "srv_7f2" });
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.value.window).toBe("1h");
  });

  test("rejects arguments that are not an object", () => {
    const check = validateToolArguments("get_server", ["srv_7f2"]);
    expect(check.ok).toBe(false);
  });
});
