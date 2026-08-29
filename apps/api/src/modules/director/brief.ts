/**
 * The brief: what the Director's model is allowed to say, and how a value
 * becomes one.
 *
 * The brief is not a rule document and cannot become one. It carries a request
 * in plain English, which `authorRules` then turns into a document that
 * validation.ts has accepted. That indirection is the point: the Director has no
 * private path into the registry, so the only vocabulary it can reach is the one
 * every other author reaches, and a model that has just read world data cannot
 * hand a document straight to a builder.
 *
 * Abstaining is a first-class answer. A Director that must produce something
 * every hour produces noise for fifty of them, and the hourly limit protects the
 * owner from volume while this field protects them from content. It is also the
 * expected outcome on a quiet or hostile window: nothing observed is worth a
 * change, so nothing is queued.
 */

/** Matches the `rationale` cap on the Proposal contract, so a brief cannot build an unstorable row. */
const MAX_RATIONALE = 2000;

/** The request becomes `source_prompt` on the authored version, so it is bounded too. */
const MAX_REQUEST = 2000;

export type ProposalBrief =
  | {
      readonly propose: true;
      /**
       * Plain English, handed to authorRules as the owner request. It is model
       * output written after reading world data, so authoring quotes it inside a
       * data section and strips the section delimiters out of it, exactly as it
       * would for text a person typed.
       */
      readonly request: string;
      readonly rationale: string;
      readonly confidence: number;
    }
  | { readonly propose: false; readonly rationale: string };

export class BriefParseError extends Error {
  constructor(message: string) {
    super(`The Director's model did not return a usable brief: ${message}`);
    this.name = "BriefParseError";
  }
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new BriefParseError(`"${field}" is not a string.`);
  const text = value.trim();
  if (text.length === 0) throw new BriefParseError(`"${field}" is empty.`);
  if (text.length > max) {
    throw new BriefParseError(`"${field}" is ${text.length} characters, over the ${max} cap.`);
  }
  return text;
}

/**
 * Parse a candidate brief.
 *
 * Throws rather than returning a union, because a union invites a caller to read
 * a request off the failure branch. There is nothing usable in a malformed
 * brief: the run ends and the server gets a quiet hour.
 */
export function parseBrief(candidate: unknown): ProposalBrief {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new BriefParseError("it is not a JSON object.");
  }

  const record = candidate as Record<string, unknown>;
  const rationale = requireText(record.rationale, "rationale", MAX_RATIONALE);

  // Strictly boolean. A truthy string is how "propose": "no" would become a
  // proposal, and that string is one the model could have picked up from data.
  if (record.propose === false) return { propose: false, rationale };
  if (record.propose !== true) throw new BriefParseError('"propose" is not true or false.');

  const confidence = record.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    throw new BriefParseError('"confidence" is not a finite number.');
  }
  if (confidence < 0 || confidence > 1) {
    throw new BriefParseError(`"confidence" is ${confidence}, outside 0 to 1.`);
  }

  return {
    propose: true,
    request: requireText(record.request, "request", MAX_REQUEST),
    rationale,
    confidence,
  };
}
