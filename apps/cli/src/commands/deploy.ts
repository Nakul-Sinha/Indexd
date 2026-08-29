import type { Deployment, DeploymentState } from "@farlands/contracts";
import { defineCommand } from "citty";
import type { ApiClient, ApiResult } from "../api.ts";
import { resolveApprovalToken } from "../auth.ts";
import { CliError, EXIT } from "../errors.ts";
import type { OutputPort } from "../output/index.ts";
import { apiFor, credentialSources } from "../runtime.ts";
import type { StallPolicy } from "../watch.ts";
import { openTransitionFeed, watchDeployment } from "../watch.ts";
import type { ActTarget, CommandContext } from "./shared.ts";
import {
  GLOBAL_ARGS,
  parseVersion,
  refuseWithoutApproval,
  requireServerId,
  resolveDeployTarget,
  rollbackCommandFor,
  SERVER_ARG,
} from "./shared.ts";

const WATCH_ARGS = {
  watch: {
    type: "boolean" as const,
    description: "Follow the deployment, one line per state transition",
    default: false,
  },
  "on-stall": {
    type: "enum" as const,
    description:
      "What to do when a state exceeds its provisional stall budget: report it, or abort the deployment",
    options: ["report", "abort"],
    default: "report",
  },
  "stall-budget-ms": {
    type: "string" as const,
    description:
      "Override the provisional per-state stall budget, in milliseconds. For CI, where the defaults are far longer than a run",
  },
  "poll-interval-ms": {
    type: "string" as const,
    description: "How often to poll GET /v1/deployments/:id when the event stream is quiet",
  },
};

export function deployCommand(ctx: CommandContext) {
  return defineCommand({
    meta: { name: "deploy", description: "Deploy a rule set version. Requires an approval token." },
    args: {
      server: SERVER_ARG,
      version: {
        type: "string" as const,
        description: "Rule set version to deploy",
        required: true,
      },
      ...WATCH_ARGS,
      ...GLOBAL_ARGS,
    },
    async run({ args }) {
      const api = apiFor(ctx.runtime);
      const serverId = requireServerId(args.server);
      const version = parseVersion(args.version);
      const target = await resolveDeployTarget(api, serverId, version);

      const approvalToken = resolveApprovalToken(credentialSources(ctx.runtime));
      if (!approvalToken) {
        ctx.runtime.out.refusal(refuseWithoutApproval("deploy_rules", target));
        ctx.outcome.exitCode = EXIT.refused;
        return;
      }

      ctx.outcome.exitCode = await startAndFollow(ctx, {
        api,
        target,
        start: () =>
          api.deploy(serverId, { rule_set_version: version, approval_token: approvalToken }),
        watch: Boolean(args.watch),
        onStall: stallPolicy(args["on-stall"]),
        stallBudgetMs: optionalMs(args["stall-budget-ms"], "--stall-budget-ms"),
        pollIntervalMs: optionalMs(args["poll-interval-ms"], "--poll-interval-ms"),
      });
    },
  });
}

export interface StartAndFollowOptions {
  api: ApiClient;
  target: ActTarget;
  start: () => Promise<ApiResult<{ deployment: Deployment }>>;
  watch: boolean;
  onStall: StallPolicy;
  stallBudgetMs: number | null;
  pollIntervalMs: number | null;
}

/**
 * The shared body of deploy and rollback.
 *
 * Rollback is an ordinary deployment with source and target reversed, so it gets
 * the same approval gate, the same state stream and the same stall handling.
 * Giving it a separate path would be the way the two quietly stop agreeing.
 */
export async function startAndFollow(
  ctx: CommandContext,
  options: StartAndFollowOptions,
): Promise<(typeof EXIT)[keyof typeof EXIT]> {
  const out: OutputPort = ctx.runtime.out;
  const { serverId } = options.target;

  // Subscribed before the deployment exists, so the first transitions are not
  // lost to the round trip that creates it.
  const feed = options.watch ? openTransitionFeed({ api: options.api, serverId, out }) : null;

  let started: ApiResult<{ deployment: Deployment }>;
  try {
    started = await options.start();
  } catch (error) {
    feed?.close();
    throw error;
  }

  if (!started.ok) {
    feed?.close();
    out.refusal(started.refusal);
    return EXIT.refused;
  }

  const deployment = started.value.deployment;

  if (!feed) {
    out.view({
      records: () => [
        {
          event: "deployment_state",
          deployment_id: deployment.deployment_id,
          server_id: deployment.server_id,
          state: deployment.state,
          detail: null,
          ts: deployment.started_at,
        },
      ],
      table: () => ({
        columns: ["deployment", "server", "state", "to version"],
        rows: [
          [
            deployment.deployment_id,
            deployment.server_id,
            deployment.state,
            `v${deployment.to_version}`,
          ],
        ],
        footer: `Follow it with --watch. To undo once it lands:  ${rollbackCommandFor(serverId)}`,
      }),
    });
    return EXIT.ok;
  }

  const watched = await watchDeployment({
    api: options.api,
    out,
    feed,
    serverId,
    deploymentId: deployment.deployment_id,
    initialState: deployment.state,
    // Queue position on the first row, because deployments are serialised
    // cluster wide. A deployment waiting behind three others is a queue, and a
    // queue that is not shown reads as a hang.
    initialDetail:
      deployment.queue_position === null ? null : `queue position ${deployment.queue_position}`,
    rollbackCommand: rollbackCommandFor(serverId),
    onStall: options.onStall,
    now: ctx.runtime.now,
    ...(options.stallBudgetMs === null ? {} : { budgetFor: () => options.stallBudgetMs }),
    ...(options.pollIntervalMs === null ? {} : { pollIntervalMs: options.pollIntervalMs }),
  });

  return exitCodeFor(watched.finalState, watched.stalled);
}

function exitCodeFor(state: DeploymentState, stalled: boolean): (typeof EXIT)[keyof typeof EXIT] {
  if (state === "idle") return EXIT.ok;
  // A stall that was left running is its own outcome: the deployment is neither
  // finished nor failed, and a caller that treats it as a failure will retry
  // into a second deployment alongside the first.
  if (stalled && state !== "aborted") return EXIT.stalled;
  return EXIT.unsuccessful;
}

function stallPolicy(raw: unknown): StallPolicy {
  return raw === "abort" ? "abort" : "report";
}

function optionalMs(raw: unknown, flag: string): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CliError(`${flag} must be a positive number of milliseconds, got ${String(raw)}.`);
  }
  return value;
}
