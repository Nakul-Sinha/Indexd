import { Value } from "@sinclair/typebox/value";
import {
  type Rule,
  RuleDocument,
  type RuleDocument as RuleDocumentType,
  type ServerRuleContext,
} from "./rule-document.provisional.ts";

/**
 * PROVISIONAL VALIDATOR. THIS FILE IS A STAND-IN AND WILL BE DELETED.
 *
 * The real validation.ts arrives with the lifted plugin-builder and is the only
 * path from a rule document to a build. It is the security boundary, it arrives
 * reviewed, and it is never ported or rewritten. See PROVISIONAL-VOCABULARY.md.
 *
 * What this stand-in preserves, because the authoring repair loop is built
 * against it and must not have to change when the real one lands:
 *
 *   - the call shape, validateRuleDocument(document, context)
 *   - the result shape, a discriminated union rather than a thrown error
 *   - errors legible enough to hand back to a model as repair instructions
 *   - no bypass. There is no trusted-caller flag and there never will be.
 */

export const PROVISIONAL_VALIDATOR = true as const;

export interface ValidationError {
  /** JSON path into the document, for instance "rules[2].region". */
  path: string;
  code: string;
  message: string;
  /** Repair guidance. This is what makes a failure usable by a model or a human. */
  hint?: string;
}

export type ValidationResult =
  | { ok: true; document: RuleDocumentType }
  | { ok: false; errors: ValidationError[] };

/**
 * Gamerules this vocabulary is allowed to set. The narrowness is the point: the
 * safety property comes from constraining the vocabulary, and widening it is a
 * reviewed security change rather than a config edit.
 */
const ALLOWED_GAMERULES = new Set([
  "do_daylight_cycle",
  "do_weather_cycle",
  "do_mob_spawning",
  "keep_inventory",
  "mob_griefing",
  "random_tick_speed",
  "player_sleeping_percentage",
]);

/** Rules that may not be silently disabled by scaling to zero. */
const ZERO_MULTIPLIER_FORBIDDEN_TARGETS = new Set(["player"]);

function shapeErrors(document: unknown): ValidationError[] {
  return [...Value.Errors(RuleDocument, document)].slice(0, 20).map((error) => ({
    path: error.path.replace(/^\//, "").replaceAll("/", "."),
    code: "shape",
    message: error.message,
    hint: "Match the rule document schema exactly. Every rule needs a 'rule' kind and an 'id'.",
  }));
}

function semanticErrors(document: RuleDocumentType, context: ServerRuleContext): ValidationError[] {
  const errors: ValidationError[] = [];
  const regions = new Set(context.regions);
  const seenIds = new Set<string>();

  document.rules.forEach((rule: Rule, index: number) => {
    const at = `rules[${index}]`;

    if (seenIds.has(rule.id)) {
      errors.push({
        path: `${at}.id`,
        code: "duplicate_rule_id",
        message: `Rule id "${rule.id}" is used more than once.`,
        hint: "Every rule in a document needs a unique id.",
      });
    }
    seenIds.add(rule.id);

    if ("region" in rule && rule.region !== undefined && !regions.has(rule.region)) {
      errors.push({
        path: `${at}.region`,
        code: "unknown_region",
        message: `Server ${context.server_id} has no region named "${rule.region}".`,
        hint:
          regions.size > 0
            ? `Use one of: ${[...regions].join(", ")}. Or omit "region" to apply the rule world-wide.`
            : 'This server has no regions defined, so omit "region" to apply the rule world-wide.',
      });
    }

    if (rule.rule === "gamerule" && !ALLOWED_GAMERULES.has(rule.name)) {
      errors.push({
        path: `${at}.name`,
        code: "gamerule_not_permitted",
        message: `"${rule.name}" is not in the permitted gamerule set.`,
        hint: `Permitted gamerules: ${[...ALLOWED_GAMERULES].join(", ")}.`,
      });
    }

    if (
      rule.rule === "damage_modifier" &&
      rule.multiplier === 0 &&
      ZERO_MULTIPLIER_FORBIDDEN_TARGETS.has(rule.target)
    ) {
      errors.push({
        path: `${at}.multiplier`,
        code: "multiplier_disables_damage",
        message: "A multiplier of 0 against players makes them invulnerable.",
        hint: "Use a small positive multiplier such as 0.25 to reduce damage instead.",
      });
    }

    if (
      (rule.rule === "entity_drop" || rule.rule === "block_drop") &&
      rule.replace_default === true &&
      rule.drops.every((drop) => drop.chance === 0)
    ) {
      errors.push({
        path: `${at}.drops`,
        code: "drops_unreachable",
        message: "Every drop has chance 0 while replace_default is true, so nothing can ever drop.",
        hint: "Give at least one drop a non-zero chance, or set replace_default to false.",
      });
    }
  });

  return errors;
}

/**
 * Validate a candidate rule document. Shape first, then semantics: a document
 * that fails the schema is not fed through the semantic pass, because the
 * semantic pass would report cascading nonsense that is useless as repair input.
 */
export function validateRuleDocument(
  document: unknown,
  context: ServerRuleContext,
): ValidationResult {
  const shape = shapeErrors(document);
  if (shape.length > 0) return { ok: false, errors: shape };

  const typed = document as RuleDocumentType;
  const semantic = semanticErrors(typed, context);
  if (semantic.length > 0) return { ok: false, errors: semantic };

  return { ok: true, document: typed };
}

/** Render errors as the repair instruction handed back to a model. */
export function formatValidationErrors(errors: readonly ValidationError[]): string {
  return errors
    .map((error) => {
      const hint = error.hint ? ` ${error.hint}` : "";
      return `- ${error.path}: ${error.message}${hint}`;
    })
    .join("\n");
}
