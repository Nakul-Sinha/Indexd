import { TOOL_DEFINITIONS, type ToolClass, type ToolName, toolInputs } from "@farlands/contracts";
import type { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

/**
 * Tool schemas, generated rather than written.
 *
 * TypeBox types are JSON Schema at runtime, so `toolInputs` is already the
 * schema and this file serializes it rather than translating it. That is the
 * whole mechanical guarantee: there is no hand-maintained copy of the tool
 * surface to drift from the contract, and a test asserts the bytes emitted here
 * equal the manifest `packages/contracts` commits.
 */

/** The object form of JSON Schema that the MCP tool definition requires. */
export interface JsonSchemaObject {
  $schema?: string;
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  [keyword: string]: unknown;
}

export interface JsonSchemaProperty {
  type?: string;
  default?: unknown;
  [keyword: string]: unknown;
}

/**
 * Annotation hints, derived from the class rather than chosen per tool.
 *
 * The class boundary is the security boundary, so an agent reading the tool list
 * should be able to see the boundary without reading thirteen descriptions.
 * Deriving the hints from the class also means a tool cannot quietly claim to be
 * read only while sitting in the act class.
 */
function annotationsFor(toolClass: ToolClass): ToolAnnotations {
  switch (toolClass) {
    case "read":
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
    case "draft":
      // Not read only: a draft appends a durable rule version row. It is not
      // destructive either, because nothing live changes.
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
    case "act":
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: false };
  }
}

function cloneSchema(name: ToolName): JsonSchemaObject {
  // Round tripping through JSON drops the TypeBox symbol keys, so what an agent
  // receives is exactly what the contracts package serializes to schemas/.
  return JSON.parse(JSON.stringify(toolInputs[name])) as JsonSchemaObject;
}

export function generateToolSchemas(): Tool[] {
  return TOOL_DEFINITIONS.map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: cloneSchema(definition.name),
    annotations: annotationsFor(definition.class),
    // The class travels with the tool so a caller can see the boundary it is
    // about to cross without inferring it from prose.
    _meta: { "farlands/class": definition.class },
  }));
}

export interface ToolSurfaceDrift {
  /** Named in TOOL_DEFINITIONS with nothing behind it. */
  missing: string[];
  /** Implemented here but absent from TOOL_DEFINITIONS. */
  unexpected: string[];
}

/**
 * Compare an implementation registry against the contract.
 *
 * Both directions matter. A definition with no implementation is a tool an agent
 * can call and get an error from; an implementation with no definition is a tool
 * nobody reviewed, reachable by name from any caller who guesses it. The second
 * is the one that would matter at a security review.
 */
export function toolSurfaceDrift(implemented: readonly string[]): ToolSurfaceDrift {
  const defined = new Set<string>(TOOL_DEFINITIONS.map((t) => t.name));
  const built = new Set(implemented);
  return {
    missing: [...defined].filter((name) => !built.has(name)).sort(),
    unexpected: [...built].filter((name) => !defined.has(name)).sort(),
  };
}

export class ToolSurfaceDriftError extends Error {
  constructor(readonly drift: ToolSurfaceDrift) {
    const parts: string[] = [];
    if (drift.missing.length > 0) parts.push(`no implementation for: ${drift.missing.join(", ")}`);
    if (drift.unexpected.length > 0) {
      parts.push(`not in TOOL_DEFINITIONS: ${drift.unexpected.join(", ")}`);
    }
    super(`MCP tool surface disagrees with @farlands/contracts (${parts.join("; ")})`);
    this.name = "ToolSurfaceDriftError";
  }
}

/** Fail at construction, not at the first call, so drift cannot ship. */
export function assertToolSurface(implemented: readonly string[]): void {
  const drift = toolSurfaceDrift(implemented);
  if (drift.missing.length > 0 || drift.unexpected.length > 0) {
    throw new ToolSurfaceDriftError(drift);
  }
}

const validator = new AjvJsonSchemaValidator();
const compiled = new Map<string, (input: unknown) => { valid: boolean; errorMessage?: string }>();

function validatorFor(name: ToolName) {
  const cached = compiled.get(name);
  if (cached) return cached;
  const fresh = validator.getValidator<unknown>(cloneSchema(name) as never);
  compiled.set(name, fresh);
  return fresh;
}

export type ArgumentCheck =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * Validate arguments against the tool's own contract schema, server side.
 *
 * The client is asked to validate too, but an agent framework that gets this
 * wrong, or a caller that skips the schema entirely, must not reach a tool body
 * with arguments the contract does not describe.
 *
 * Unknown properties are rejected rather than ignored. Silently dropping an
 * argument is how a call an operator reads as one thing quietly becomes another,
 * and an agent that sends an argument we do not understand has told us its model
 * of this tool is wrong.
 */
export function validateToolArguments(name: ToolName, args: unknown): ArgumentCheck {
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    return { ok: false, message: "arguments must be an object" };
  }

  const schema = cloneSchema(name);
  const supplied = (args ?? {}) as Record<string, unknown>;
  const declared = schema.properties ?? {};

  const unknownKeys = Object.keys(supplied).filter((key) => !(key in declared));
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      message: `unknown argument(s) for ${name}: ${unknownKeys.sort().join(", ")}`,
    };
  }

  const withDefaults = applyDeclaredDefaults(schema, supplied);
  const result = validatorFor(name)(withDefaults);
  if (!result.valid) {
    return { ok: false, message: `invalid arguments for ${name}: ${result.errorMessage ?? ""}` };
  }
  return { ok: true, value: withDefaults };
}

/**
 * Fill in defaults the contract declares.
 *
 * `get_world_telemetry.window` is required and carries a default, so a caller
 * that omits it is asking for the documented default rather than making a
 * mistake. Applying it here rather than inside the tool keeps the default in one
 * place, the contract.
 */
function applyDeclaredDefaults(
  schema: JsonSchemaObject,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const filled: Record<string, unknown> = { ...args };
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (filled[key] === undefined && property.default !== undefined) {
      filled[key] = property.default;
    }
  }
  return filled;
}
