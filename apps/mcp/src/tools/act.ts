import type { ApiRequest } from "../api-client.ts";
import {
  approvalRefusalFrom,
  notFoundRefusalFrom,
  ok,
  refused,
  refusedUpstream,
  type ToolOutcome,
} from "../results.ts";
import {
  asRecord,
  isContractNotFound,
  type ToolContext,
  type ToolHandler,
  upstreamFailure,
} from "./context.ts";

/**
 * ACT tools: they touch a live world, they carry an approval token, and they
 * fail closed.
 *
 * This file never inspects a token. It does not check an expiry, a principal or
 * a digest, and it has no notion of a token being spent. It forwards what the
 * caller supplied and reports what the API said. That is deliberate: the
 * approval check has to have exactly one implementation, because two
 * implementations of the same check eventually disagree and the disagreement is
 * silent. The consequence to be honest about is that this package inherits the
 * API's enforcement rather than adding a second layer to it.
 *
 * What this file does own is the fail-closed property. Every path that is not a
 * clear success from the API returns a refusal or an error value, and none of
 * them returns something an agent could read as "deployed".
 */

async function act(input: {
  tool: string;
  request: ApiRequest;
  context: ToolContext;
  resource: string;
  note: string;
}): Promise<ToolOutcome> {
  const result = await input.context.api.send(input.context.caller, input.request);
  const body = asRecord(result.body);

  // An approval refusal is rebuilt through the contract constructor so the bytes
  // match the CLI, the phone and the deploy endpoint exactly. Checked before the
  // status code, because the refusal is the answer regardless of how it is
  // wrapped in HTTP.
  if (body?.error === "approval_required") {
    const rebuilt = approvalRefusalFrom(body, input.tool);
    if (rebuilt) return refused(rebuilt);
    return refusedUpstream("approval_required", body);
  }

  if (result.status === 403 || (result.status === 404 && isContractNotFound(result.body))) {
    return refused(notFoundRefusalFrom(result.body, input.tool, input.resource));
  }

  if (!result.ok) return upstreamFailure(input.tool, result);

  return ok({ ...body, note: input.note });
}

const deploy_rules: ToolHandler = async (args, context) => {
  const { server_id, version, approval_token } = args as unknown as {
    server_id: string;
    version: number;
    approval_token?: string;
  };
  return act({
    tool: "deploy_rules",
    context,
    resource: `server ${server_id}`,
    request: {
      method: "POST",
      path: `/v1/servers/${server_id}/deploy`,
      body: { rule_set_version: version, approval_token },
    },
    note: "Queued. Follow it with get_deployment; players move only after the candidate passes health checks.",
  });
};

const rollback: ToolHandler = async (args, context) => {
  const { server_id, approval_token } = args as unknown as {
    server_id: string;
    approval_token?: string;
  };
  return act({
    tool: "rollback",
    context,
    resource: `server ${server_id}`,
    request: {
      method: "POST",
      path: `/v1/servers/${server_id}/rollback`,
      body: { approval_token },
    },
    note: "Queued. Rollback restores the previous rules and preserves play since the change; it does not undo what the rule already did to the world.",
  });
};

const create_server: ToolHandler = async (args, context) => {
  const { name, approval_token } = args as unknown as { name: string; approval_token?: string };
  return act({
    tool: "create_server",
    context,
    resource: `server named ${name}`,
    request: { method: "POST", path: "/v1/servers", body: { name, approval_token } },
    note: "This is a cluster operation. Rollback does not undo it.",
  });
};

const power_action: ToolHandler = async (args, context) => {
  const { server_id, action, approval_token } = args as unknown as {
    server_id: string;
    action: string;
    approval_token?: string;
  };
  return act({
    tool: "power_action",
    context,
    resource: `server ${server_id}`,
    request: {
      method: "POST",
      path: `/v1/servers/${server_id}/power`,
      body: { action, approval_token },
    },
    note:
      action === "stop" || action === "restart"
        ? "This is a cluster operation. Every connected player was disconnected and no snapshot undoes that."
        : "This is a cluster operation. Rollback does not undo it.",
  });
};

export const actTools = {
  deploy_rules,
  rollback,
  create_server,
  power_action,
} satisfies Record<string, ToolHandler>;
