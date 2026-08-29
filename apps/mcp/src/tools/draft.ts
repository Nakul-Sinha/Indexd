import { failed, ok } from "../results.ts";
import { asRecord, refuseUnreadable, type ToolHandler } from "./context.ts";

/**
 * DRAFT tools: no live effect, and not free.
 *
 * They invoke a model and append durable rule version rows, so the dispatcher
 * charges every call in this class against the rate limiter before the body
 * runs. Enforcing it by class rather than inside each body means a tool added to
 * the class later is limited without anyone remembering to add the check.
 */

const author_rules: ToolHandler = async (args, context) => {
  const { server_id, prompt } = args as unknown as { server_id: string; prompt: string };
  const result = await context.api.send(context.caller, {
    method: "POST",
    path: `/v1/servers/${server_id}/rule-sets/author`,
    body: { prompt },
  });

  // A drafting failure is an outcome, not an exception: the agent is told which
  // prompt failed and what the validator objected to, and no invalid document
  // was persisted. Checked before the status code, because the shape of the
  // answer is what matters and not how it was wrapped in HTTP.
  const body = asRecord(result.body);
  if (body?.error === "authoring_failed") return failed("authoring_failed", body);

  const refusal = refuseUnreadable(result, "author_rules", `server ${server_id}`);
  if (refusal) return refusal;

  return ok({
    ...body,
    note: "A new rule set version was drafted. Nothing was deployed: deploying it needs a human approval token.",
  });
};

const preview_deploy: ToolHandler = async (args, context) => {
  const { server_id, version } = args as unknown as { server_id: string; version: number };
  const result = await context.api.send(context.caller, {
    method: "POST",
    path: `/v1/servers/${server_id}/preview`,
    body: { rule_set_version: version },
  });

  const refusal = refuseUnreadable(result, "preview_deploy", `server ${server_id}`);
  if (refusal) return refusal;

  return ok({
    ...asRecord(result.body),
    note: "Dry run only. Nothing was queued and no player was moved.",
  });
};

export const draftTools = {
  author_rules,
  preview_deploy,
} satisfies Record<string, ToolHandler>;
