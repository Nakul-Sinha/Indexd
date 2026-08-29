import { canonicalize, type RuleDiffEntry } from "@farlands/contracts";

/**
 * The semantic diff, rendered as sentences.
 *
 * A diff nobody can read is a gate nobody uses, so this never emits a JSON
 * patch. It walks the rule vocabulary, which means it grows when the vocabulary
 * grows, and that is the correct coupling rather than an accident.
 *
 * It lives here for now because there is no shared renderer and no diff endpoint
 * to call. When the real vocabulary replaces the provisional stand-in this moves
 * next to it, so the walk and the vocabulary stay in one place. Until then the
 * fallback branch below is what keeps an unrecognised rule kind visible instead
 * of silently absent from a diff a human is about to approve.
 */

interface RuleLike {
  rule?: unknown;
  id?: unknown;
  [key: string]: unknown;
}

export interface RuleDocumentLike {
  rules?: unknown;
}

interface Described {
  subject: string;
  value: string;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function multiplier(value: unknown): string {
  return typeof value === "number" ? `${value}x` : String(value);
}

function drops(value: unknown): string {
  if (!Array.isArray(value)) return String(value);
  return value
    .map((entry) => {
      const drop = entry as Record<string, unknown>;
      const chance = typeof drop.chance === "number" ? Math.round(drop.chance * 100) : null;
      const suffix = chance === null ? "" : ` at ${chance}%`;
      return `${drop.count ?? "?"}x ${drop.item ?? "?"}${suffix}`;
    })
    .join(", ");
}

function inRegion(rule: RuleLike): string {
  const region = text(rule.region);
  return region ? ` in ${region}` : "";
}

/** One rule, as a subject and the value that subject currently has. */
export function describeRule(rule: RuleLike): Described {
  const id = text(rule.id) ?? "unnamed";
  switch (rule.rule) {
    case "mob_spawn_rate":
      return {
        subject: `${text(rule.mob) ?? "mob"} spawns${inRegion(rule)}`,
        value: multiplier(rule.multiplier),
      };
    case "damage_modifier":
      return {
        subject: `damage to ${text(rule.target) ?? "target"}${inRegion(rule)}`,
        value: multiplier(rule.multiplier),
      };
    case "entity_drop": {
      const when = text(rule.when);
      const window = when && when !== "always" ? ` at ${when}` : "";
      return {
        subject: `${text(rule.entity) ?? "entity"} drops${window}${inRegion(rule)}`,
        value: drops(rule.drops),
      };
    }
    case "block_drop":
      return {
        subject: `${text(rule.block) ?? "block"} drops${inRegion(rule)}`,
        value: drops(rule.drops),
      };
    case "gamerule":
      return {
        subject: `gamerule ${text(rule.name) ?? "unnamed"}`,
        value: String(rule.value),
      };
    default:
      // An unrecognised kind is still shown. Omitting it would hide a change
      // from the human approving the diff, which is the one thing this must not
      // do.
      return { subject: `${text(rule.rule) ?? "rule"} ${id}`, value: canonicalize(rule) };
  }
}

function indexById(document: RuleDocumentLike | null): Map<string, RuleLike> {
  const index = new Map<string, RuleLike>();
  const rules = document?.rules;
  if (!Array.isArray(rules)) return index;
  for (const entry of rules) {
    if (typeof entry !== "object" || entry === null) continue;
    const rule = entry as RuleLike;
    const id = text(rule.id);
    if (id) index.set(id, rule);
  }
  return index;
}

/** Compare two rule documents by rule id, the identity the vocabulary gives them. */
export function diffRuleDocuments(
  from: RuleDocumentLike | null,
  to: RuleDocumentLike | null,
): RuleDiffEntry[] {
  const before = indexById(from);
  const after = indexById(to);
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();

  const entries: RuleDiffEntry[] = [];
  for (const id of ids) {
    const oldRule = before.get(id);
    const newRule = after.get(id);

    if (oldRule && !newRule) {
      const described = describeRule(oldRule);
      entries.push({
        kind: "removed",
        rule_id: id,
        summary: `${described.subject}: removed (was ${described.value})`,
        before: described.value,
        after: null,
      });
      continue;
    }

    if (!oldRule && newRule) {
      const described = describeRule(newRule);
      entries.push({
        kind: "added",
        rule_id: id,
        summary: `${described.subject}: added (${described.value})`,
        before: null,
        after: described.value,
      });
      continue;
    }

    if (!oldRule || !newRule) continue;
    if (canonicalize(oldRule) === canonicalize(newRule)) continue;

    const oldDescribed = describeRule(oldRule);
    const newDescribed = describeRule(newRule);
    const subject =
      oldDescribed.subject === newDescribed.subject
        ? newDescribed.subject
        : `${oldDescribed.subject} -> ${newDescribed.subject}`;
    entries.push({
      kind: "changed",
      rule_id: id,
      summary: `${subject}: ${oldDescribed.value} -> ${newDescribed.value}`,
      before: oldDescribed.value,
      after: newDescribed.value,
    });
  }

  return entries;
}
