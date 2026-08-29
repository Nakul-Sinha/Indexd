import {
  type ApprovalRefusalReason,
  approvalRequired,
  contentDigest,
  type Deployment,
  digestsEqual,
  isAbortable,
  TOKEN_PREFIX,
  toSseFrame,
  UNMEASURED_WINDOW,
} from "@farlands/contracts";
import { Elysia, t } from "elysia";
import { isScenario, runScenario } from "./scenarios.ts";
import {
  approvals,
  deployments,
  makeId,
  nextEventId,
  publish,
  replay,
  rollups,
  ruleVersions,
  seed,
  servers,
  subscribe,
  telemetryReceived,
} from "./state.ts";

/**
 * The mock API.
 *
 * Its job is to unblock four clients before the real controller exists, and to
 * make the paths that matter testable from day one: the structured refusal in
 * all five of its forms, a deployment that stalls, and SSE replay.
 *
 * It is a development target. It holds no durable state, enforces no real
 * authorization beyond a hardcoded principal, and is deleted or demoted to a
 * test fixture at integration.
 */

seed();

/** The principal every request is treated as, unless a header says otherwise. */
const DEFAULT_PRINCIPAL = "usr_demo";

/** A fixed machine token, so clients have something to send while auth is a stub. */
export const MOCK_MACHINE_TOKEN = `${TOKEN_PREFIX.machine}mockdevtoken`;

function principalOf(headers: Record<string, string | undefined>): string {
  return headers["x-mock-principal"] ?? DEFAULT_PRINCIPAL;
}

/** Scoping: the mock owns srv_7f2 and deliberately does not own srv_a19. */
function ownsServer(principal: string, serverId: string): boolean {
  if (!servers.has(serverId)) return false;
  if (serverId === "srv_a19") return principal === "usr_other";
  return principal === DEFAULT_PRINCIPAL;
}

function notFound(tool: string, resource: string) {
  return {
    error: "not_found" as const,
    tool,
    resource,
    message: `No ${resource} you can see.`,
    resolution:
      "Read tools are scoped to servers you own. Check the server id, or ask the owner to grant access.",
  };
}

function latestVersion(serverId: string) {
  const versions = ruleVersions.get(serverId) ?? [];
  return versions[versions.length - 1];
}

/**
 * The approval check, in all five of its failure modes. This is the single most
 * useful thing the mock provides: Engineer 1 can build and test every refusal
 * path months before the real approvals module exists.
 */
function checkApproval(input: {
  token: string | undefined;
  principal: string;
  serverId: string;
  version: number;
  digest: string;
}): ApprovalRefusalReason | null {
  if (!input.token) return "missing";

  const record = approvals.get(input.token);
  if (!record) return "missing";
  if (record.consumed_at !== null) return "consumed";
  if (record.expires_at < Date.now()) return "expired";
  if (record.issued_to !== input.principal) return "principal_mismatch";
  if (!digestsEqual(record.content_digest, input.digest)) return "digest_mismatch";
  if (record.server_id !== input.serverId || record.rule_set_version !== input.version) {
    return "digest_mismatch";
  }
  return null;
}

const app = new Elysia()
  .get("/health", () => ({ ok: true, mock: true }))

  .get("/v1/servers", ({ headers }) => {
    const principal = principalOf(headers);
    return {
      items: [...servers.values()].filter((server) => ownsServer(principal, server.server_id)),
      next_cursor: null,
    };
  })

  .get("/v1/servers/:id", ({ headers, params, set }) => {
    const principal = principalOf(headers);
    if (!ownsServer(principal, params.id)) {
      set.status = 404;
      return notFound("get_server", `server ${params.id}`);
    }
    return servers.get(params.id);
  })

  .get("/v1/servers/:id/rule-sets", ({ headers, params, set }) => {
    const principal = principalOf(headers);
    if (!ownsServer(principal, params.id)) {
      set.status = 404;
      return notFound("list_rule_sets", `server ${params.id}`);
    }
    return { items: ruleVersions.get(params.id) ?? [], next_cursor: null };
  })

  .get("/v1/servers/:id/telemetry", ({ headers, params, set }) => {
    const principal = principalOf(headers);
    if (!ownsServer(principal, params.id)) {
      set.status = 404;
      return notFound("get_world_telemetry", `server ${params.id}`);
    }
    return {
      server_id: params.id,
      window_start: new Date(Date.now() - 3_600_000).toISOString(),
      window_end: new Date().toISOString(),
      metrics: rollups.get(params.id),
    };
  })

  /** Mint an approval token. A human session only, which the mock takes on trust. */
  .post(
    "/v1/approvals",
    ({ body, headers }) => {
      const principal = principalOf(headers);
      const token = `${TOKEN_PREFIX.approval}${makeId("")}${Math.random().toString(36).slice(2, 10)}`;
      approvals.set(token, {
        token,
        server_id: body.server_id,
        rule_set_version: body.rule_set_version,
        content_digest: body.content_digest,
        issued_to: body.issued_to ?? principal,
        expires_at: Date.now() + (body.ttl_seconds ?? 600) * 1000,
        consumed_at: null,
      });
      return {
        token,
        expires_at: new Date(Date.now() + (body.ttl_seconds ?? 600) * 1000).toISOString(),
        content_digest: body.content_digest,
      };
    },
    {
      body: t.Object({
        server_id: t.String(),
        rule_set_version: t.Integer(),
        content_digest: t.String(),
        issued_to: t.Optional(t.String()),
        ttl_seconds: t.Optional(t.Integer()),
      }),
    },
  )

  .post(
    "/v1/servers/:id/preview",
    ({ headers, params, set }) => {
      const principal = principalOf(headers);
      if (!ownsServer(principal, params.id)) {
        set.status = 404;
        return notFound("preview_deploy", `server ${params.id}`);
      }
      const version = latestVersion(params.id);
      return {
        server_id: params.id,
        from_version: servers.get(params.id)?.current_version ?? null,
        to_version: version?.version ?? 1,
        content_digest: version?.content_digest ?? contentDigest({}),
        diff: {
          server_id: params.id,
          from_version: null,
          to_version: version?.version ?? 1,
          entries: [],
        },
        // Never a guess. The window is unmeasured until M1 reports.
        estimated_window: UNMEASURED_WINDOW,
        quota_impact: {
          candidate_cpu_millicores: 1000,
          candidate_memory_mib: 2048,
          candidate_storage_mib: 8192,
          headroom_available: true,
        },
        rollback_target: servers.get(params.id)?.current_version ?? null,
      };
    },
    { body: t.Optional(t.Any()) },
  )

  .post(
    "/v1/servers/:id/deploy",
    ({ body, headers, params, query, set }) => {
      const principal = principalOf(headers);
      if (!ownsServer(principal, params.id)) {
        set.status = 404;
        return notFound("deploy_rules", `server ${params.id}`);
      }

      const versions = ruleVersions.get(params.id) ?? [];
      const target = versions.find((v) => v.version === body.rule_set_version);
      const digest = target?.content_digest ?? contentDigest({ unknown: body.rule_set_version });

      const reason = checkApproval({
        token: body.approval_token,
        principal,
        serverId: params.id,
        version: body.rule_set_version,
        digest,
      });

      if (reason) {
        // A refusal is a value with a 200-adjacent status, not a server error.
        // 403 is honest about the outcome while keeping the body parseable.
        set.status = 403;
        return approvalRequired({
          reason,
          tool: "deploy_rules",
          server_id: params.id,
          rule_set_version: body.rule_set_version,
          content_digest: digest,
        });
      }

      const record = approvals.get(body.approval_token as string);
      if (record) record.consumed_at = Date.now();

      const deployment: Deployment = {
        deployment_id: makeId("dep_"),
        server_id: params.id,
        from_version: servers.get(params.id)?.current_version ?? null,
        to_version: body.rule_set_version,
        state: "queued",
        candidate_pod: null,
        snapshot_id: null,
        player_visible_ms: null,
        queue_position: 0,
        approved_by: record?.issued_to ?? null,
        initiated_by: principal,
        started_at: new Date().toISOString(),
        finished_at: null,
        error: null,
      };
      deployments.set(deployment.deployment_id, deployment);

      const requested = query.scenario ?? "happy";
      const scenario = isScenario(requested) ? requested : "happy";
      runScenario(deployment, scenario, query.step_ms ? Number(query.step_ms) : 600);

      return { deployment };
    },
    {
      body: t.Object({
        rule_set_version: t.Integer(),
        approval_token: t.Optional(t.String()),
      }),
      query: t.Object({
        scenario: t.Optional(t.String()),
        step_ms: t.Optional(t.String()),
      }),
    },
  )

  .get("/v1/deployments/:id", ({ params, set }) => {
    const deployment = deployments.get(params.id);
    if (!deployment) {
      set.status = 404;
      return notFound("get_deployment", `deployment ${params.id}`);
    }
    return { deployment };
  })

  .post("/v1/deployments/:id/abort", ({ params, set }) => {
    const deployment = deployments.get(params.id);
    if (!deployment) {
      set.status = 404;
      return notFound("abort", `deployment ${params.id}`);
    }

    // Abort is safe at any state before cutover and a no-op afterwards. The
    // classification lives in the contract, not here.
    if (!isAbortable(deployment.state)) {
      return { deployment_id: params.id, state: deployment.state, no_op: true };
    }

    const aborted: Deployment = {
      ...deployment,
      state: "aborted",
      finished_at: new Date().toISOString(),
      error: "aborted on request; players returned to the original server",
    };
    deployments.set(params.id, aborted);
    publish({
      id: nextEventId(),
      type: "deployment_state",
      server_id: deployment.server_id,
      ts: new Date().toISOString(),
      data: {
        deployment_id: params.id,
        state: "aborted",
        detail: "candidate deleted, no trace left",
        queue_position: null,
      },
    });
    return { deployment_id: params.id, state: "aborted" as const, no_op: false };
  })

  /** Cluster-internal in the real system. Open here, and loudly labelled. */
  .post(
    "/internal/telemetry/:serverId",
    ({ body, params }) => {
      const count = telemetryReceived.get(params.serverId) ?? 0;
      const events = Array.isArray(body?.events) ? body.events.length : 0;
      telemetryReceived.set(params.serverId, count + events);
      return { accepted: events, total: count + events };
    },
    { body: t.Optional(t.Any()) },
  )

  /** SSE with Last-Event-ID replay. */
  .get("/v1/servers/:id/events", ({ headers, params, set }) => {
    const principal = principalOf(headers);
    if (!ownsServer(principal, params.id)) {
      set.status = 404;
      return notFound("events", `server ${params.id}`);
    }

    set.headers["content-type"] = "text/event-stream";
    set.headers["cache-control"] = "no-cache";
    set.headers.connection = "keep-alive";

    const lastEventId = headers["last-event-id"] ?? null;

    return new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (frame: string) => controller.enqueue(encoder.encode(frame));

        for (const event of replay(params.id, lastEventId)) {
          send(toSseFrame(event));
        }

        const unsubscribe = subscribe(params.id, (event) => send(toSseFrame(event)));

        const heartbeat = setInterval(() => {
          send(
            toSseFrame({
              id: nextEventId(),
              type: "heartbeat",
              server_id: params.id,
              ts: new Date().toISOString(),
              data: {},
            }),
          );
        }, 15_000);

        const close = () => {
          clearInterval(heartbeat);
          unsubscribe();
          controller.close();
        };
        setTimeout(close, 10 * 60_000);
      },
    });
  });

export type MockApp = typeof app;
export { app };
