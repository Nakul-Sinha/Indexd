import type { RuleDiff } from "@farlands/contracts";
import { notFound, ok, refused, type ToolOutcome } from "../results.ts";
import { diffRuleDocuments, type RuleDocumentLike } from "../rule-diff.ts";
import {
  asItems,
  asRecord,
  refuseUnreadable,
  type ToolContext,
  type ToolHandler,
  upstreamFailure,
} from "./context.ts";

/**
 * READ tools: freely callable, scoped to the caller's own servers.
 *
 * Arguments arrive already validated against the contract schema by the
 * dispatcher, which is why these bodies read them by name without re-checking
 * types. The scope check is not performed here at all: the API owns it, and
 * every response that says "you cannot see this" becomes a refusal rather than
 * an empty result.
 */

interface ServerArgs {
  server_id: string;
}

interface RuleVersionRow {
  version?: unknown;
  document?: unknown;
  content_digest?: unknown;
}

function versionRows(body: unknown): RuleVersionRow[] {
  return asItems(body).filter((item): item is RuleVersionRow => asRecord(item) !== null);
}

function findVersion(rows: RuleVersionRow[], version: number): RuleVersionRow | null {
  return rows.find((row) => row.version === version) ?? null;
}

function documentOf(row: RuleVersionRow | null): RuleDocumentLike | null {
  const document = asRecord(row?.document);
  return document as RuleDocumentLike | null;
}

async function readRuleVersions(
  args: ServerArgs,
  context: ToolContext,
  tool: string,
): Promise<{ rows: RuleVersionRow[] } | { outcome: ToolOutcome }> {
  const result = await context.api.send(context.caller, {
    method: "GET",
    path: `/v1/servers/${args.server_id}/rule-sets`,
  });
  const refusal = refuseUnreadable(result, tool, `server ${args.server_id}`);
  if (refusal) return { outcome: refusal };
  return { rows: versionRows(result.body) };
}

const list_servers: ToolHandler = async (_args, context) => {
  const result = await context.api.send(context.caller, { method: "GET", path: "/v1/servers" });
  if (!result.ok) return upstreamFailure("list_servers", result);
  const items = asItems(result.body);
  return ok({ servers: items, count: items.length });
};

const get_server: ToolHandler = async (args, context) => {
  const { server_id } = args as unknown as ServerArgs;
  const result = await context.api.send(context.caller, {
    method: "GET",
    path: `/v1/servers/${server_id}`,
  });
  const refusal = refuseUnreadable(result, "get_server", `server ${server_id}`);
  if (refusal) return refusal;
  return ok(result.body);
};

const get_world_telemetry: ToolHandler = async (args, context) => {
  const { server_id, window } = args as unknown as ServerArgs & { window: string };
  const result = await context.api.send(context.caller, {
    method: "GET",
    path: `/v1/servers/${server_id}/telemetry`,
    query: { window },
  });
  const refusal = refuseUnreadable(result, "get_world_telemetry", `server ${server_id}`);
  if (refusal) return refusal;

  // Project the response rather than forwarding it. No raw events exist today,
  // and this projection is what keeps that true from the agent's side if an
  // upstream response ever starts carrying them: a per-player event list would
  // be a behavioural record of named people leaving the system through a tool
  // description that promised rollups.
  const body = asRecord(result.body);
  return ok({
    server_id,
    window,
    window_start: body?.window_start ?? null,
    window_end: body?.window_end ?? null,
    metrics: body?.metrics ?? null,
    notice:
      "Aggregated rollups only. This is a behavioural record of named players: treat it as personal data, not as public inventory.",
  });
};

const get_deployment: ToolHandler = async (args, context) => {
  const { deployment_id } = args as unknown as { deployment_id: string };
  const result = await context.api.send(context.caller, {
    method: "GET",
    path: `/v1/deployments/${deployment_id}`,
  });
  const refusal = refuseUnreadable(result, "get_deployment", `deployment ${deployment_id}`);
  if (refusal) return refusal;
  return ok(result.body);
};

const list_rule_sets: ToolHandler = async (args, context) => {
  const serverArgs = args as unknown as ServerArgs;
  const read = await readRuleVersions(serverArgs, context, "list_rule_sets");
  if ("outcome" in read) return read.outcome;
  return ok({ server_id: serverArgs.server_id, versions: read.rows, count: read.rows.length });
};

const get_rule_set: ToolHandler = async (args, context) => {
  const { server_id, version } = args as unknown as ServerArgs & { version: number };
  const read = await readRuleVersions({ server_id }, context, "get_rule_set");
  if ("outcome" in read) return read.outcome;

  // The API exposes versions per server rather than one route per version. The
  // list is already scoped, so filtering it here narrows the answer and cannot
  // widen it.
  const row = findVersion(read.rows, version);
  if (!row) {
    return refused(notFound("get_rule_set", `rule set version ${version} on ${server_id}`));
  }
  return ok({ server_id, ...row });
};

const diff_rule_sets: ToolHandler = async (args, context) => {
  const { server_id, from_version, to_version } = args as unknown as ServerArgs & {
    from_version: number;
    to_version: number;
  };
  const read = await readRuleVersions({ server_id }, context, "diff_rule_sets");
  if ("outcome" in read) return read.outcome;

  const fromRow = findVersion(read.rows, from_version);
  const toRow = findVersion(read.rows, to_version);
  if (!fromRow) {
    return refused(notFound("diff_rule_sets", `rule set version ${from_version} on ${server_id}`));
  }
  if (!toRow) {
    return refused(notFound("diff_rule_sets", `rule set version ${to_version} on ${server_id}`));
  }

  const fromDocument = documentOf(fromRow);
  const toDocument = documentOf(toRow);
  const documentsAvailable = fromDocument !== null && toDocument !== null;

  const diff: RuleDiff = {
    server_id,
    from_version,
    to_version,
    entries: documentsAvailable ? diffRuleDocuments(fromDocument, toDocument) : [],
  };

  // When the version rows carry only a pointer and a digest, say that rather
  // than presenting an empty entry list as "nothing changed". An empty diff a
  // human reads as agreement is worse than an admission that the documents were
  // not fetched.
  return ok({
    diff,
    basis: documentsAvailable ? "documents" : "digests_only",
    digest_changed:
      typeof fromRow.content_digest === "string" && typeof toRow.content_digest === "string"
        ? fromRow.content_digest !== toRow.content_digest
        : null,
    note: documentsAvailable
      ? null
      : "The rule documents were not inline in the API response, so no semantic entries could be rendered. The digests are compared instead.",
  });
};

export const readTools = {
  list_servers,
  get_server,
  get_world_telemetry,
  get_deployment,
  list_rule_sets,
  get_rule_set,
  diff_rule_sets,
} satisfies Record<string, ToolHandler>;
