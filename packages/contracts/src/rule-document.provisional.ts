import { type Static, Type } from "@sinclair/typebox";

/**
 * PROVISIONAL RULE VOCABULARY. THIS FILE IS A STAND-IN AND WILL BE DELETED.
 *
 * The real vocabulary lives in types.ts inside the lifted plugin-builder, which
 * Engineer 3 brings over from the baseline repository. That file is the agent
 * action space and the capability ceiling, and it is the first of the four
 * [CONFIRM] files for exactly that reason.
 *
 * This stand-in exists so Stage A can ship fixtures, a repair loop, tool schemas
 * and a mock API before the private baseline is in hand. It is deliberately
 * small and deliberately boring. Do not add primitives here to make a feature
 * work: widening the vocabulary is a security change reviewed one primitive at a
 * time against the real file.
 *
 * The swap procedure is in PROVISIONAL-VOCABULARY.md.
 *
 * Two properties this stand-in shares with the real thing, and must keep:
 *   1. Every primitive is stateless. A backend transfer preserves the player
 *      connection but not in-memory plugin state, so nothing here may require
 *      the plugin to remember anything between ticks.
 *   2. Shape validity is not semantic validity. A document can satisfy every
 *      type here and still be rejected, for instance by naming a region the
 *      server has not defined.
 */

export const PROVISIONAL_VOCABULARY = true as const;

const Probability = Type.Number({ minimum: 0, maximum: 1 });
const Multiplier = Type.Number({ minimum: 0, maximum: 16, description: "Scaling factor" });
const Identifier = Type.String({
  pattern: "^[a-z][a-z0-9_]{1,47}$",
  description: "Lowercase snake_case identifier, matching Minecraft 26.x registry naming",
});
const RegionName = Type.String({ pattern: "^[a-z][a-z0-9_]{1,31}$" });

const DropEntry = Type.Object({
  item: Identifier,
  count: Type.Integer({ minimum: 1, maximum: 64 }),
  chance: Probability,
});

const TimeWindow = Type.Union([Type.Literal("always"), Type.Literal("day"), Type.Literal("night")]);

/** Scale how often a mob spawns, optionally only inside a named region. */
const MobSpawnRate = Type.Object({
  rule: Type.Literal("mob_spawn_rate"),
  id: Identifier,
  mob: Identifier,
  region: Type.Optional(RegionName),
  multiplier: Multiplier,
});

/** Change what an entity drops when it dies. */
const EntityDrop = Type.Object({
  rule: Type.Literal("entity_drop"),
  id: Identifier,
  entity: Identifier,
  when: Type.Optional(TimeWindow),
  region: Type.Optional(RegionName),
  drops: Type.Array(DropEntry, { minItems: 1, maxItems: 8 }),
  replace_default: Type.Optional(Type.Boolean()),
});

/** Change what a block drops when it is broken. */
const BlockDrop = Type.Object({
  rule: Type.Literal("block_drop"),
  id: Identifier,
  block: Identifier,
  region: Type.Optional(RegionName),
  drops: Type.Array(DropEntry, { minItems: 1, maxItems: 8 }),
  replace_default: Type.Optional(Type.Boolean()),
});

/** Scale damage dealt to a category of target. */
const DamageModifier = Type.Object({
  rule: Type.Literal("damage_modifier"),
  id: Identifier,
  target: Type.Union([Type.Literal("player"), Type.Literal("hostile"), Type.Literal("passive")]),
  region: Type.Optional(RegionName),
  multiplier: Multiplier,
});

/**
 * Set a vanilla gamerule. Minecraft 26.1 turned gamerules into a registry and
 * renamed them from camelCase to snake_case, which is why Identifier enforces
 * snake_case here.
 */
const GameruleSet = Type.Object({
  rule: Type.Literal("gamerule"),
  id: Identifier,
  name: Identifier,
  value: Type.Union([Type.Boolean(), Type.Integer({ minimum: 0, maximum: 1_000_000 })]),
});

export const Rule = Type.Union([MobSpawnRate, EntityDrop, BlockDrop, DamageModifier, GameruleSet]);
export type Rule = Static<typeof Rule>;

export const RULE_KINDS = [
  "mob_spawn_rate",
  "entity_drop",
  "block_drop",
  "damage_modifier",
  "gamerule",
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const RuleDocument = Type.Object(
  {
    schema_version: Type.Literal(1),
    rules: Type.Array(Rule, { minItems: 1, maxItems: 64 }),
  },
  {
    $id: "RuleDocument",
    additionalProperties: false,
    description: "PROVISIONAL. Replaced by the lifted vocabulary at Phase 0.",
  },
);
export type RuleDocument = Static<typeof RuleDocument>;

/**
 * Facts about a server that semantic validation needs and the document itself
 * does not carry. The real validator takes an equivalent context.
 */
export interface ServerRuleContext {
  server_id: string;
  regions: readonly string[];
}
