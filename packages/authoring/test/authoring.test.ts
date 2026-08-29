import { describe, expect, test } from "bun:test";
import { contentDigest, provisionalValidation } from "@farlands/contracts";
import {
  AuthoringFailedError,
  type AuthorRulesDeps,
  authorRules,
  MAX_ATTEMPTS,
} from "../src/index.ts";
import {
  invalidExpectations,
  invalidFixtures,
  repeated,
  type ScriptedModel,
  scriptedModel,
  serverContext,
  validFixtures,
} from "./fixtures.ts";

/**
 * The definition of done for this component, from ENGINEER-1.md section 13,
 * written as assertions someone else can run.
 *
 * Every case here drives the loop with a scripted model, so what is under test
 * is the loop and the validator boundary rather than a model's competence.
 */

function deps(model: ScriptedModel): AuthorRulesDeps {
  return {
    model: model.model,
    context: serverContext,
    source: "agent",
    createdBy: "usr_test",
  };
}

describe("a document that validates", () => {
  test("every valid fixture authors on the first attempt", async () => {
    expect(validFixtures.length).toBeGreaterThan(0);

    for (const fixture of validFixtures) {
      const model = scriptedModel([fixture.document]);
      const authored = await authorRules(
        serverContext.server_id,
        `author ${fixture.name}`,
        deps(model),
      );

      expect(authored.attempts).toBe(1);
      expect(model.calls.length).toBe(1);
      expect(fixture.document).toEqual(authored.document);
      expect(authored.content_digest).toBe(contentDigest(fixture.document));
    }
  });

  test("what the pipeline emits passes an unmodified validator on first check", async () => {
    for (const fixture of validFixtures) {
      const model = scriptedModel([fixture.document]);
      const authored = await authorRules(serverContext.server_id, "check me", deps(model));

      // The same validator, called again from outside the pipeline, on the
      // value the pipeline handed back.
      const recheck = provisionalValidation.validateRuleDocument(authored.document, serverContext);
      expect(recheck.ok).toBe(true);
    }
  });

  test("attribution travels with the result", async () => {
    const fixture = validFixtures[0];
    expect(fixture).toBeDefined();

    const model = scriptedModel([fixture?.document]);
    const authored = await authorRules(serverContext.server_id, "fewer zombies at spawn", {
      model: model.model,
      context: serverContext,
      source: "director",
      createdBy: "usr_owner",
    });

    expect(authored.source).toBe("director");
    expect(authored.source_prompt).toBe("fewer zombies at spawn");
    expect(authored.created_by).toBe("usr_owner");
    expect(authored.server_id).toBe(serverContext.server_id);
  });
});

describe("the repair loop", () => {
  const rejected = {
    schema_version: 1,
    rules: [
      {
        rule: "mob_spawn_rate",
        id: "hostiles_in_the_castle",
        mob: "zombie",
        region: "castle",
        multiplier: 1.5,
      },
    ],
  };

  test("the second call carries the first attempt's validation errors", async () => {
    const accepted = validFixtures[0]?.document;
    const model = scriptedModel([rejected, accepted]);
    await authorRules(serverContext.server_id, "more zombies in the castle", deps(model));

    expect(model.calls.length).toBe(2);

    const first = model.calls[0]?.instruction ?? "";
    const second = model.calls[1]?.instruction ?? "";

    // The exact error text the validator produced, verbatim in the retry.
    const failure = provisionalValidation.validateRuleDocument(rejected, serverContext);
    expect(failure.ok).toBe(false);
    if (failure.ok) throw new Error("the rejected fixture should not validate");
    for (const error of failure.errors) {
      expect(second).toContain(error.message);
      expect(second).toContain(error.path);
      if (error.hint) expect(second).toContain(error.hint);
    }

    // And the rejected candidate itself, so the model repairs rather than redrafts.
    expect(second).toContain("hostiles_in_the_castle");
    expect(model.calls[1]?.attempt).toBe(2);

    // The first attempt had nothing to repair.
    expect(first).not.toContain("was rejected by the validator");
    expect(model.calls[0]?.attempt).toBe(1);
  });

  test("valid output on attempt 2 succeeds and reports attempts: 2", async () => {
    const accepted = validFixtures[0]?.document;
    const model = scriptedModel([rejected, accepted]);
    const authored = await authorRules(serverContext.server_id, "second time lucky", deps(model));

    expect(authored.attempts).toBe(2);
    expect(model.calls.length).toBe(2);
    expect(accepted).toEqual(authored.document);
  });

  test("valid output on attempt 3 still succeeds", async () => {
    const accepted = validFixtures[0]?.document;
    const model = scriptedModel([rejected, rejected, accepted]);
    const authored = await authorRules(serverContext.server_id, "third time lucky", deps(model));

    expect(authored.attempts).toBe(3);
    expect(model.calls.length).toBe(3);
  });

  test("each retry reports the attempt that produced the rejected candidate", async () => {
    const accepted = validFixtures[0]?.document;
    const model = scriptedModel([rejected, rejected, accepted]);
    await authorRules(serverContext.server_id, "count the attempts", deps(model));

    expect(model.calls[1]?.instruction).toContain("Attempt 1 was rejected by the validator.");
    expect(model.calls[2]?.instruction).toContain("Attempt 2 was rejected by the validator.");
  });

  test("the cacheable prefix is byte identical across attempts", async () => {
    const accepted = validFixtures[0]?.document;
    const model = scriptedModel([rejected, rejected, accepted]);
    await authorRules(serverContext.server_id, "same prefix every time", deps(model));

    const systems = new Set(model.calls.map((call) => call.system));
    expect(systems.size).toBe(1);
  });
});

describe("exhaustion", () => {
  const neverValid = {
    schema_version: 1,
    rules: [
      {
        rule: "mob_spawn_rate",
        id: "hostiles_in_the_castle",
        mob: "zombie",
        region: "castle",
        multiplier: 1.5,
      },
    ],
  };
  const prompt = "make the castle dangerous";

  async function failedAuthoring(
    document: unknown,
  ): Promise<{ error: AuthoringFailedError; model: ScriptedModel }> {
    const model = scriptedModel(repeated(document, MAX_ATTEMPTS));
    try {
      await authorRules(serverContext.server_id, prompt, deps(model));
    } catch (caught) {
      if (caught instanceof AuthoringFailedError) return { error: caught, model };
      throw caught;
    }
    throw new Error("authoring should have failed");
  }

  test("it fails after exactly three attempts", async () => {
    const { error, model } = await failedAuthoring(neverValid);

    expect(MAX_ATTEMPTS).toBe(3);
    expect(model.calls.length).toBe(3);
    expect(error.failure.attempts).toBe(3);
  });

  test("the failure names the prompt, the last candidate and the validation errors", async () => {
    const { error } = await failedAuthoring(neverValid);
    const failure = error.failure;

    expect(failure.error).toBe("authoring_failed");
    expect(failure.prompt).toBe(prompt);
    expect(failure.last_candidate).toEqual(neverValid);
    expect(failure.validation_errors.length).toBeGreaterThan(0);
    expect(failure.validation_errors.map((entry) => entry.code)).toContain("unknown_region");
    for (const entry of failure.validation_errors) {
      expect(typeof entry.path).toBe("string");
      expect(typeof entry.message).toBe("string");
    }

    // The message alone has to be usable by whoever reads the log line.
    expect(failure.message).toContain(prompt);
    expect(failure.message).toContain("hostiles_in_the_castle");
    expect(failure.message).toContain('has no region named "castle"');
    expect(error.message).toBe(failure.message);
    expect(error.name).toBe("AuthoringFailedError");
  });

  test("no invalid document is returned, under any name", async () => {
    const { error } = await failedAuthoring(neverValid);

    // The failure carries the candidate as a candidate. Nothing on the error
    // presents it as an authored document.
    expect(Object.keys(error.failure)).not.toContain("document");
    expect("document" in error).toBe(false);

    // And it really is invalid, so the loop refused it rather than missing it.
    const recheck = provisionalValidation.validateRuleDocument(
      error.failure.last_candidate,
      serverContext,
    );
    expect(recheck.ok).toBe(false);
  });

  test("every invalid fixture fails the same way, with its own error codes", async () => {
    expect(invalidFixtures.length).toBeGreaterThan(0);

    for (const fixture of invalidFixtures) {
      const { error, model } = await failedAuthoring(fixture.document);

      expect(model.calls.length).toBe(MAX_ATTEMPTS);
      expect(error.failure.attempts).toBe(MAX_ATTEMPTS);

      const codes = new Set(error.failure.validation_errors.map((entry) => entry.code));
      for (const expected of invalidExpectations[fixture.name] ?? []) {
        expect(codes).toContain(expected);
      }
    }
  });
});

describe("the context guard", () => {
  test("a context for another server is refused before the model is called", async () => {
    const model = scriptedModel([validFixtures[0]?.document]);

    await expect(authorRules("srv_a19", "not my server", deps(model))).rejects.toThrow(
      `Rule context is for ${serverContext.server_id} but the draft is for srv_a19.`,
    );
    expect(model.calls.length).toBe(0);
  });
});
