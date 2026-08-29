import { provisionalVocabulary } from "@farlands/contracts";

/**
 * The rule document vocabulary as plain JSON Schema.
 *
 * TypeBox types are JSON Schema at runtime, so this is a copy and not a
 * translation. Nothing here re-derives the vocabulary: when the lifted one
 * lands, this file follows it without an edit, which is the property
 * PROVISIONAL-VOCABULARY.md asks every consumer to preserve.
 *
 * The JSON round trip is deliberate. TypeBox hangs its runtime metadata off
 * symbol keys, which are not JSON and would not survive the wire; stringify and
 * parse leaves exactly the schema keywords behind.
 *
 * Two uses, one source: this schema is quoted into the system prompt so the
 * model can read the vocabulary, and it is the structured-output format so
 * generation is constrained to it. Structured outputs handles shape.
 * validation.provisional.ts handles semantics, which is regions that exist,
 * primitives that are permitted, and the stateless-rules constraint. The
 * validator remains the only path in and structured outputs is not a substitute
 * for it, only a way to start the repair loop from a document that is already
 * shape-valid.
 */

/**
 * Structured outputs constrains generation against closed objects, and the
 * stand-in only closes the document root. Closing every object node can only
 * narrow what the model may emit, never widen it, so this cannot loosen the
 * capability ceiling. It is applied here rather than in contracts because the
 * requirement belongs to the generation call, not to the vocabulary.
 */
function closeObjects(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(closeObjects);
  if (node === null || typeof node !== "object") return node;

  const closed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    closed[key] = closeObjects(value);
  }
  if (closed.type === "object" && closed.additionalProperties === undefined) {
    closed.additionalProperties = false;
  }
  return closed;
}

export const RULE_DOCUMENT_SCHEMA = closeObjects(
  JSON.parse(JSON.stringify(provisionalVocabulary.RuleDocument)),
) as Record<string, unknown>;

/** The schema as it is quoted to the model. Stable text, so the cache prefix is stable. */
export const RULE_DOCUMENT_SCHEMA_TEXT = JSON.stringify(RULE_DOCUMENT_SCHEMA, null, 2);
