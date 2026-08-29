import {
  type AuthorRulesFailure,
  contentDigest,
  provisionalValidation,
  type provisionalVocabulary,
  type RuleSource,
} from "@farlands/contracts";
import type { RuleModel } from "./model.ts";
import { buildInstruction, type RepairReport, SYSTEM_PROMPT } from "./prompt.ts";

/**
 * The validation-repair loop of ENGINEER-1.md section 5: generate, validate,
 * feed the errors back, and give up loudly.
 *
 * The bound is three attempts and it is not configurable. It caps model spend
 * per draft, it forces failure to be a first-class outcome with a usable
 * message instead of an infinite polish loop, and the AuthorRulesFailure
 * contract caps `attempts` at 3 as well, so a caller that could raise the
 * ceiling could emit a failure its own consumers cannot parse.
 */
export const MAX_ATTEMPTS = 3;

/** Enough of the last candidate to recognise it in a log line. The whole of it is on the failure. */
const CANDIDATE_PREVIEW_LIMIT = 1000;

export interface AuthorRulesDeps {
  /** Injected so the pipeline can be exercised without a network or an API key. */
  readonly model: RuleModel;
  /**
   * The server facts semantic validation needs. The caller owns the lookup
   * because the three callers of this function already hold the server row.
   */
  readonly context: provisionalVocabulary.ServerRuleContext;
  /** Attribution is never optional: every rule version records where it came from. */
  readonly source: RuleSource;
  readonly createdBy: string;
  /** Display name for the server, if there is one. Treated as data, like the regions. */
  readonly serverName?: string;
}

/**
 * What a successful draft hands back.
 *
 * This is the payload E3's route turns into a `rule_set_versions` row. The
 * fields this package cannot know are the ones the row assigns: the version
 * number, the write-once S3 URL, the built jar, the id and the timestamp. What
 * it does carry is the digest, computed with the shared canonicalizer so the
 * value an approval token later binds to is the value computed here.
 */
export interface AuthoredRules {
  readonly server_id: string;
  readonly document: provisionalVocabulary.RuleDocument;
  readonly content_digest: string;
  readonly source: RuleSource;
  readonly source_prompt: string;
  readonly created_by: string;
  /** How many generations it took. 1 means the first candidate validated. */
  readonly attempts: number;
}

/**
 * Thrown when three attempts have not produced a valid document.
 *
 * A thrown error rather than a result union, because a union invites a caller
 * to read a document off the failure branch. There is no document on this
 * error: the rejected candidate is on `failure.last_candidate`, named for what
 * it is.
 */
export class AuthoringFailedError extends Error {
  constructor(readonly failure: AuthorRulesFailure) {
    super(failure.message);
    this.name = "AuthoringFailedError";
  }
}

/**
 * Plain English in, a validated rule document out. Deploys nothing, persists
 * nothing, and writes nothing: this package has no side effect other than the
 * model call, which is what keeps seam 4 a seam.
 */
export async function authorRules(
  serverId: string,
  prompt: string,
  deps: AuthorRulesDeps,
): Promise<AuthoredRules> {
  // Validating against another server's facts would let a rule naming a region
  // this server does not have sail through the semantic pass, so a mismatch is
  // a caller bug worth failing on rather than a draft worth attempting.
  if (deps.context.server_id !== serverId) {
    throw new Error(
      `Rule context is for ${deps.context.server_id} but the draft is for ${serverId}.`,
    );
  }

  let repair: RepairReport | undefined;
  let lastCandidate: unknown = null;
  let lastErrors: readonly provisionalValidation.ValidationError[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const instruction = buildInstruction({
      context: deps.context,
      serverName: deps.serverName,
      prompt,
      repair,
    });

    // A transport failure is not a validation failure, so it is not repaired
    // here and not counted as an attempt. It propagates; the SDK has already
    // retried what is worth retrying.
    const candidate = await deps.model.generate({
      system: SYSTEM_PROMPT,
      instruction,
      attempt,
    });

    const result = provisionalValidation.validateRuleDocument(candidate, deps.context);
    if (result.ok) {
      return {
        server_id: serverId,
        document: result.document,
        content_digest: contentDigest(result.document),
        source: deps.source,
        source_prompt: prompt,
        created_by: deps.createdBy,
        attempts: attempt,
      };
    }

    lastCandidate = candidate;
    lastErrors = result.errors;
    repair = { attempt, candidate, errors: result.errors };
  }

  throw new AuthoringFailedError({
    error: "authoring_failed",
    prompt,
    attempts: MAX_ATTEMPTS,
    last_candidate: lastCandidate,
    validation_errors: lastErrors.map((error) => ({ ...error })),
    message: failureMessage(serverId, prompt, lastCandidate, lastErrors),
  });
}

function failureMessage(
  serverId: string,
  prompt: string,
  candidate: unknown,
  errors: readonly provisionalValidation.ValidationError[],
): string {
  return [
    `Could not author a valid rule document for ${serverId} after ${MAX_ATTEMPTS} attempts.`,
    `Prompt: ${prompt}`,
    `Last candidate: ${preview(candidate)}`,
    "Validation errors that rejected it:",
    provisionalValidation.formatValidationErrors(errors),
  ].join("\n");
}

function preview(candidate: unknown): string {
  const text = JSON.stringify(candidate) ?? String(candidate);
  return text.length > CANDIDATE_PREVIEW_LIMIT
    ? `${text.slice(0, CANDIDATE_PREVIEW_LIMIT)}... (truncated, full candidate is on the failure)`
    : text;
}
