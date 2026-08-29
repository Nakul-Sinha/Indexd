import { provisionalValidation, provisionalVocabulary } from "@farlands/contracts";

/**
 * The random-valid-rule sampler: the third arm's rule source.
 *
 * The baseline arm exists so that "the Director's proposals help" is a claim
 * with something to fail against. Without a random arm, the only comparison
 * available is the server before the Director existed, and a rule change of any
 * kind moves a friend group's numbers on novelty alone. The falsification
 * criterion the project set itself, that the Director's proposals must show a
 * change random valid rule edits do not, cannot be evaluated at all unless the
 * random edits are deployed and measured on the same terms.
 *
 * Two properties this file must keep:
 *
 *   1. Documents leave here only if `validateRuleDocument` accepted them. The
 *      atoms below are candidate material, never authority. If the sampler
 *      drifts from the vocabulary it produces candidates the validator rejects,
 *      which surfaces as a throw rather than as a deployed document nobody
 *      checked.
 *   2. There is no bypass. A candidate that fails validation is discarded here
 *      exactly as an authored document would be discarded in the pipeline, and
 *      a baseline document reaches a deployment through the same gate as a
 *      Director document or a human one.
 */

type RuleDocument = provisionalVocabulary.RuleDocument;
type Rule = provisionalVocabulary.Rule;
type ServerRuleContext = provisionalVocabulary.ServerRuleContext;
type RuleKind = provisionalVocabulary.RuleKind;

/**
 * Candidate identifiers, chosen to be ordinary rather than interesting. A
 * baseline arm that only ever sampled dramatic changes would be a different
 * experiment: the comparison wants the kind of edit a person might plausibly
 * make, drawn without judgement about which edits are good.
 */
const MOBS = ["zombie", "creeper", "skeleton", "spider", "enderman", "cow", "sheep"] as const;
const ENTITIES = ["zombie", "creeper", "skeleton", "spider", "cow", "sheep"] as const;
const BLOCKS = ["stone", "dirt", "gravel", "sand", "oak_log", "coal_ore", "iron_ore"] as const;
const ITEMS = ["coal", "iron_ingot", "emerald", "gunpowder", "bone", "leather", "apple"] as const;

/**
 * Gamerules the sampler may name, split by the value shape each one takes.
 *
 * This list is narrower than the validator's permitted set is allowed to be, and
 * that is the safe direction: a name the validator rejects becomes a discarded
 * candidate rather than a deployment. The validator remains the authority on
 * what is permitted.
 */
const BOOLEAN_GAMERULES = [
  "do_daylight_cycle",
  "do_weather_cycle",
  "do_mob_spawning",
  "keep_inventory",
  "mob_griefing",
] as const;
const INTEGER_GAMERULES = [
  { name: "random_tick_speed", min: 1, max: 12 },
  { name: "player_sleeping_percentage", min: 0, max: 100 },
] as const;

/** A deterministic generator, so a sampled arm can be replayed from its seed. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
}

/**
 * mulberry32. Small, seedable and reproducible, which is what an experiment
 * record needs: "which documents did the baseline arm actually deploy" has to
 * be answerable months later from the seed alone.
 */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  const chosen = values[Math.floor(rng.next() * values.length)];
  if (chosen === undefined) throw new Error("cannot sample from an empty list");
  return chosen;
}

function integer(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng.next() * (max - min + 1));
}

/** Rounded so a document read by a human is legible and a digest is stable. */
function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/**
 * A multiplier that is a change rather than a no-op, and never zero. Zero
 * against players is rejected by the validator; zero against anything else is a
 * silent disable, which is a larger edit than this arm is sampling.
 */
function multiplier(rng: Rng): number {
  return round(0.25 + rng.next() * 2.25, 2);
}

function maybeRegion(rng: Rng, context: ServerRuleContext): string | undefined {
  if (context.regions.length === 0) return undefined;
  // World-wide about half the time, because most rule edits are not scoped.
  if (rng.next() < 0.5) return undefined;
  return pick(rng, context.regions);
}

function drops(rng: Rng): { item: string; count: number; chance: number }[] {
  return Array.from({ length: integer(rng, 1, 3) }, () => ({
    item: pick(rng, ITEMS),
    count: integer(rng, 1, 8),
    // Strictly positive: an all-zero drop table with replace_default set is
    // rejected, and an unreachable drop is not a rule change at all.
    chance: round(0.05 + rng.next() * 0.9, 2),
  }));
}

/**
 * One sampler per rule kind, keyed by the vocabulary's own union.
 *
 * The Record type is the coupling: a primitive added to the vocabulary fails to
 * compile here until the sampler covers it, so the baseline arm cannot quietly
 * stop exercising part of the action space the Director is allowed to use.
 */
const RULE_SAMPLERS: Record<RuleKind, (rng: Rng, context: ServerRuleContext, id: string) => Rule> =
  {
    mob_spawn_rate: (rng, context, id) => {
      const region = maybeRegion(rng, context);
      return {
        rule: "mob_spawn_rate",
        id,
        mob: pick(rng, MOBS),
        multiplier: multiplier(rng),
        ...(region === undefined ? {} : { region }),
      };
    },

    entity_drop: (rng, context, id) => {
      const region = maybeRegion(rng, context);
      const when = pick(rng, ["always", "day", "night"] as const);
      return {
        rule: "entity_drop",
        id,
        entity: pick(rng, ENTITIES),
        drops: drops(rng),
        replace_default: rng.next() < 0.2,
        when,
        ...(region === undefined ? {} : { region }),
      };
    },

    block_drop: (rng, context, id) => {
      const region = maybeRegion(rng, context);
      return {
        rule: "block_drop",
        id,
        block: pick(rng, BLOCKS),
        drops: drops(rng),
        replace_default: rng.next() < 0.2,
        ...(region === undefined ? {} : { region }),
      };
    },

    damage_modifier: (rng, context, id) => {
      const region = maybeRegion(rng, context);
      return {
        rule: "damage_modifier",
        id,
        target: pick(rng, ["player", "hostile", "passive"] as const),
        multiplier: multiplier(rng),
        ...(region === undefined ? {} : { region }),
      };
    },

    gamerule: (rng, _context, id) => {
      if (rng.next() < 0.6) {
        return {
          rule: "gamerule",
          id,
          name: pick(rng, BOOLEAN_GAMERULES),
          value: rng.next() < 0.5,
        };
      }
      const chosen = pick(rng, INTEGER_GAMERULES);
      return {
        rule: "gamerule",
        id,
        name: chosen.name,
        value: integer(rng, chosen.min, chosen.max),
      };
    },
  };

export interface SamplerOptions {
  rng: Rng;
  /** How many rules the document holds. The vocabulary permits 1 to 64. */
  ruleCount?: number;
  /**
   * How many candidates to build before giving up. A sampler that cannot land a
   * valid document is a broken sampler, and failing loudly is the only outcome
   * that does not end in an unvalidated document reaching a server.
   */
  maxAttempts?: number;
}

export const DEFAULT_MAX_ATTEMPTS = 20;

export interface RandomRuleSample {
  document: RuleDocument;
  /** Candidates the validator refused before this one. Expected to be zero. */
  rejected: number;
}

export class SamplerExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastErrors: readonly provisionalValidation.ValidationError[],
  ) {
    super(
      `random rule sampler produced no valid document in ${attempts} attempts:\n${provisionalValidation.formatValidationErrors(
        lastErrors,
      )}`,
    );
    this.name = "SamplerExhaustedError";
  }
}

function candidate(rng: Rng, context: ServerRuleContext, ruleCount: number): RuleDocument {
  const kinds = provisionalVocabulary.RULE_KINDS;
  const rules = Array.from({ length: ruleCount }, (_unused, index) => {
    const kind = pick(rng, kinds);
    // Ids are positional, so duplicates are impossible by construction rather
    // than by a retry loop that would hide a generator that repeats itself.
    return RULE_SAMPLERS[kind](rng, context, `random_${kind}_${index}`);
  });
  return { schema_version: 1, rules };
}

/**
 * Sample one random rule document that the validator accepted.
 *
 * The validation call is not a formality: it is the same call the authoring
 * pipeline makes, on the same context, and its verdict is final here too.
 */
export function sampleRandomRuleDocument(
  context: ServerRuleContext,
  options: SamplerOptions,
): RandomRuleSample {
  const ruleCount = options.ruleCount ?? 3;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let lastErrors: readonly provisionalValidation.ValidationError[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = provisionalValidation.validateRuleDocument(
      candidate(options.rng, context, ruleCount),
      context,
    );
    if (result.ok) return { document: result.document, rejected: attempt };
    lastErrors = result.errors;
  }

  throw new SamplerExhaustedError(maxAttempts, lastErrors);
}

/** Several documents from one generator, for a baseline arm that runs more than once. */
export function sampleRandomRuleDocuments(
  count: number,
  context: ServerRuleContext,
  options: SamplerOptions,
): RandomRuleSample[] {
  return Array.from({ length: count }, () => sampleRandomRuleDocument(context, options));
}
