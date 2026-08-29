import Anthropic from "@anthropic-ai/sdk";
import type { RuleModel, RuleModelRequest } from "./model.ts";
import { RULE_DOCUMENT_SCHEMA } from "./schema.ts";

/**
 * The one file in this package that knows which provider is behind RuleModel.
 *
 * STACK.md section 5 chose the first-party API over Bedrock because caching,
 * structured outputs and adaptive thinking land there first, and it made that
 * choice reversible on the condition that client construction stays in a single
 * file. This is that file. Moving to Bedrock is `new AnthropicBedrockMantle(...)`
 * and an `anthropic.`-prefixed model id here; nothing else in the package sees
 * a provider type.
 *
 * Nothing in the repository exercises this against the live API. There is no
 * key in CI and the tests never make one necessary, so the request shape below
 * is typechecked and asserted field by field, not integration tested.
 */

/** Authoring correctness is worth the tokens, so this is the default for both callers. */
export const AUTHORING_MODEL = "claude-opus-5";

/**
 * A ceiling, not a spend. Streaming removes the HTTP-timeout reason to keep it
 * low, and a truncated document is a wasted attempt out of only three.
 */
const MAX_TOKENS = 64_000;

export interface AnthropicRuleModelOptions {
  /** Supply a pre-configured client to change credentials, base URL or retries. */
  readonly client?: Anthropic;
  readonly model?: string;
}

/** Raised when the response cannot yield a candidate at all, which is not a validation failure. */
export class RuleModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleModelError";
  }
}

/**
 * The request, built separately from the call so its shape can be asserted
 * without a network.
 *
 * The details that matter, and that a stale pattern would get wrong:
 * `thinking` is adaptive with no token budget, because `budget_tokens` is
 * removed on this model and returns a 400. Effort lives inside `output_config`
 * alongside the structured-output format, and `output_format` is deprecated.
 * There is no assistant prefill, which is also removed on this model; the
 * output shape comes from the format instead. The cache breakpoint sits on the
 * system block because the vocabulary schema and the rules of engagement are
 * byte-identical on every call while the turn below them never is.
 */
export function authoringRequest(request: RuleModelRequest) {
  return {
    model: AUTHORING_MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: RULE_DOCUMENT_SCHEMA },
    },
    system: [
      {
        type: "text",
        text: request.system,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: request.instruction }],
  } satisfies Anthropic.MessageStreamParams;
}

/**
 * Read the candidate out of a finished message.
 *
 * Returns unknown and parses without inspecting: deciding whether this is a
 * rule document is the validator's job, and a provider adapter that made that
 * call would be the bypass the safety argument says does not exist.
 */
export function parseCandidate(
  message: Pick<Anthropic.Message, "content" | "stop_reason">,
): unknown {
  if (message.stop_reason === "refusal") {
    throw new RuleModelError("The model declined to answer, so there is no candidate to validate.");
  }

  const text = message.content.find((block) => block.type === "text")?.text;
  if (text === undefined) {
    throw new RuleModelError("The response carried no text block, so there is no candidate.");
  }

  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new RuleModelError(`The response was not JSON: ${(cause as Error).message}`);
  }
}

export function createAnthropicRuleModel(options: AnthropicRuleModelOptions = {}): RuleModel {
  // Constructed here rather than at module load so importing this package does
  // not require a credential. The key reaches the process through Pod Identity
  // and the SDK's own environment resolution; it is never read or logged here.
  const client = options.client ?? new Anthropic();
  const model = options.model ?? AUTHORING_MODEL;

  return {
    async generate(request: RuleModelRequest): Promise<unknown> {
      // Streaming, then finalMessage(), because adaptive thinking at high
      // effort makes for long generations and a non-streaming call at this
      // max_tokens is an HTTP-timeout risk.
      const stream = client.messages.stream({ ...authoringRequest(request), model });
      return parseCandidate(await stream.finalMessage());
    },
  };
}
