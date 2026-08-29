import { describe, expect, test } from "bun:test";
import {
  AUTHORING_MODEL,
  authoringRequest,
  parseCandidate,
  RULE_DOCUMENT_SCHEMA,
  RuleModelError,
  SYSTEM_PROMPT,
} from "../src/index.ts";

/**
 * The provider adapter, asserted rather than exercised.
 *
 * No test in this repository makes a live API call, so the value here is a
 * check that the request shape is the current one. Each assertion below stands
 * for a parameter that returns a 400 if it is written the stale way, which is
 * the failure mode a typechecker cannot catch.
 */

const request = {
  system: SYSTEM_PROMPT,
  instruction: "<owner_request>\nhello\n</owner_request>",
  attempt: 1,
};

describe("the authoring request", () => {
  const params = authoringRequest(request);

  test("it names the model exactly", () => {
    expect(AUTHORING_MODEL).toBe("claude-opus-5");
    expect(params.model).toBe("claude-opus-5");
  });

  test("thinking is adaptive and carries no token budget", () => {
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.thinking).not.toHaveProperty("budget_tokens");
  });

  test("effort and the output format both live inside output_config", () => {
    expect(params.output_config.effort).toBe("high");
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.output_config.format.schema).toBe(RULE_DOCUMENT_SCHEMA);
    expect(params).not.toHaveProperty("output_format");
  });

  test("the structured output format is the rule document vocabulary", () => {
    expect(RULE_DOCUMENT_SCHEMA.type).toBe("object");
    expect(RULE_DOCUMENT_SCHEMA.required).toEqual(["schema_version", "rules"]);
    expect(RULE_DOCUMENT_SCHEMA.additionalProperties).toBe(false);
  });

  test("the cache breakpoint sits on the system block", () => {
    expect(params.system.length).toBe(1);
    expect(params.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(params.system[0]?.text).toBe(SYSTEM_PROMPT);
  });

  test("there is no assistant prefill", () => {
    expect(params.messages.length).toBe(1);
    expect(params.messages.every((message) => message.role === "user")).toBe(true);
    expect(params.messages[0]?.content).toBe(request.instruction);
  });
});

describe("reading the candidate back", () => {
  test("a JSON answer is returned unparsed of meaning and unvalidated", () => {
    const candidate = parseCandidate({
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"schema_version":1,"rules":[]}', citations: null }],
    });

    // An empty rules array is invalid, and the adapter returns it anyway. That
    // is the point: only the validator decides.
    expect(candidate).toEqual({ schema_version: 1, rules: [] });
  });

  test("a refusal is a model error, not a validation failure", () => {
    expect(() => parseCandidate({ stop_reason: "refusal", content: [] })).toThrow(RuleModelError);
  });

  test("a response with no text block is a model error", () => {
    expect(() => parseCandidate({ stop_reason: "end_turn", content: [] })).toThrow(
      "carried no text block",
    );
  });

  test("a response that is not JSON is a model error", () => {
    expect(() =>
      parseCandidate({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "sorry, here are some thoughts instead", citations: null }],
      }),
    ).toThrow(RuleModelError);
  });
});
