import { type Static, Type } from "@sinclair/typebox";
import { ServerId } from "./common.ts";

/**
 * The MCP tool surface, defined once here so the tool schemas, the CLI and the
 * phone cannot disagree about what a deployment or a rule version looks like.
 *
 * The class boundary is the security boundary:
 *
 *   READ   freely callable, scoped to the caller's own servers. Telemetry is a
 *          behavioural record of named players, so scoping is a privacy
 *          obligation and not an access-control nicety.
 *   DRAFT  no live effect, but invokes a model and creates durable rows, so it
 *          is rate limited server-side to bound cost.
 *   ACT    touches a live world. Requires an approval token and fails closed.
 *
 * apps/mcp generates its JSON Schema from this file. CI regenerates and fails on
 * drift, which is the mechanical guarantee behind seam 1.
 */

export const ToolClass = Type.Union([
  Type.Literal("read"),
  Type.Literal("draft"),
  Type.Literal("act"),
]);
export type ToolClass = Static<typeof ToolClass>;

const ServerArg = Type.Object({ server_id: ServerId });

export const toolInputs = {
  list_servers: Type.Object({}),
  get_server: ServerArg,
  get_world_telemetry: Type.Object({
    server_id: ServerId,
    window: Type.Union([Type.Literal("1h"), Type.Literal("6h"), Type.Literal("24h")], {
      default: "1h",
    }),
  }),
  get_deployment: Type.Object({ deployment_id: Type.String() }),
  list_rule_sets: ServerArg,
  get_rule_set: Type.Object({
    server_id: ServerId,
    version: Type.Integer({ minimum: 1 }),
  }),
  diff_rule_sets: Type.Object({
    server_id: ServerId,
    from_version: Type.Integer({ minimum: 1 }),
    to_version: Type.Integer({ minimum: 1 }),
  }),
  author_rules: Type.Object({
    server_id: ServerId,
    prompt: Type.String({ minLength: 1, maxLength: 4000 }),
  }),
  preview_deploy: Type.Object({
    server_id: ServerId,
    version: Type.Integer({ minimum: 1 }),
  }),
  deploy_rules: Type.Object({
    server_id: ServerId,
    version: Type.Integer({ minimum: 1 }),
    approval_token: Type.Optional(Type.String()),
  }),
  rollback: Type.Object({
    server_id: ServerId,
    approval_token: Type.Optional(Type.String()),
  }),
  create_server: Type.Object({
    name: Type.String({ minLength: 1, maxLength: 64 }),
    approval_token: Type.Optional(Type.String()),
  }),
  power_action: Type.Object({
    server_id: ServerId,
    action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("restart")]),
    approval_token: Type.Optional(Type.String()),
  }),
} as const;

export type ToolName = keyof typeof toolInputs;

export interface ToolDefinition {
  name: ToolName;
  class: ToolClass;
  description: string;
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "list_servers",
    class: "read",
    description: "List the servers you own, with live status and player counts.",
  },
  {
    name: "get_server",
    class: "read",
    description: "Get one server: state, address, player count, TPS, and quota position.",
  },
  {
    name: "get_world_telemetry",
    class: "read",
    description:
      "Aggregated world activity for a server you own. Returns rolling windows, never raw events. This is a behavioural record of named players; treat it as personal data.",
  },
  {
    name: "get_deployment",
    class: "read",
    description: "State of a deployment, using the canonical deployment state names.",
  },
  {
    name: "list_rule_sets",
    class: "read",
    description: "Rule set history for a server you own.",
  },
  {
    name: "get_rule_set",
    class: "read",
    description: "One rule set version: the document, its digest, its source, and its author.",
  },
  {
    name: "diff_rule_sets",
    class: "read",
    description:
      "Semantic diff between two rule set versions, rendered as sentences rather than a JSON patch.",
  },
  {
    name: "author_rules",
    class: "draft",
    description:
      "Turn a plain English description into a validated rule document and store it as a new version. Deploys nothing. Rate limited.",
  },
  {
    name: "preview_deploy",
    class: "draft",
    description:
      "Dry run a deployment: semantic diff, estimated player-visible window, quota impact, and rollback target. No live effect.",
  },
  {
    name: "deploy_rules",
    class: "act",
    description:
      "Deploy a rule set version to a live world. Requires an approval token minted by a human against the exact content digest. Without one this returns a structured refusal and changes nothing.",
  },
  {
    name: "rollback",
    class: "act",
    description:
      "Deploy the previous rule version onto the current world. Play since the change is preserved. This stops the rule acting further; it does not undo what the rule already did. Requires an approval token.",
  },
  {
    name: "create_server",
    class: "act",
    description:
      "Provision a new server. This is a cluster operation and is not undone by rollback. Requires an approval token.",
  },
  {
    name: "power_action",
    class: "act",
    description:
      "Start, stop, or restart a server. A stop disconnects every connected player and no snapshot undoes that. Requires an approval token.",
  },
] as const;

export const TOOLS_BY_CLASS: Record<ToolClass, readonly ToolName[]> = {
  read: TOOL_DEFINITIONS.filter((t) => t.class === "read").map((t) => t.name),
  draft: TOOL_DEFINITIONS.filter((t) => t.class === "draft").map((t) => t.name),
  act: TOOL_DEFINITIONS.filter((t) => t.class === "act").map((t) => t.name),
};

/** Every act tool accepts an approval token and every one of them fails closed without it. */
export function requiresApproval(name: ToolName): boolean {
  return TOOLS_BY_CLASS.act.includes(name);
}

/**
 * Draft tools are rate limited because they invoke a model and create durable
 * rows. The number is a starting point to tune, not a value from the source
 * material; the requirement is that a limit exists and is enforced server-side.
 */
export const DRAFT_RATE_LIMIT = {
  calls: 10,
  window_seconds: 3600,
  scope: "principal+server",
} as const;
