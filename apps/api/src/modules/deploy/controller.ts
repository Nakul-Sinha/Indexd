import { randomUUID } from "node:crypto";
import type { DeploymentState, DeploymentView } from "@farlands/contracts";
import { PRE_CUTOVER_STATES } from "@farlands/contracts";
import { buildRuleJar, readStaticRule } from "@farlands/plugin-builder";
import { deleteCandidate, provisionCandidate } from "../provisioning/candidate";
import { releaseDeploymentHeadroom, reserveDeploymentHeadroom } from "../quota/headroom";
import { issueTransfer, waitForAck } from "../velocity/transfers";
import { redeemApprovalToken } from "./approvals-stub";
import { AuthClient } from "./invariant";
import { admitNext, complete, enqueue, queuePosition } from "./queue";

export type DeploymentRecord = DeploymentView & {
  userId: string;
  namespace: string | null;
  liveDeployment: string | null;
  liveService: string | null;
};

const store = new Map<string, DeploymentRecord>();
const liveByServer = new Map<string, string>();

const nowIso = () => new Date().toISOString();

function view(row: DeploymentRecord): DeploymentView {
  const { userId: _u, namespace: _n, liveDeployment: _d, liveService: _s, ...rest } = row;
  return rest;
}

function assertPreCutover(row: DeploymentRecord): void {
  if (!PRE_CUTOVER_STATES.includes(row.state as (typeof PRE_CUTOVER_STATES)[number])) {
    throw new Error(`Cannot abort after cutover (state=${row.state})`);
  }
}

async function transition(
  id: string,
  state: DeploymentState,
  patch: Partial<DeploymentRecord> = {},
): Promise<DeploymentRecord> {
  const row = store.get(id);
  if (!row) throw new Error(`Unknown deployment ${id}`);
  const next: DeploymentRecord = {
    ...row,
    ...patch,
    state,
    queuePosition: state === "queued" ? queuePosition(id) : null,
  };
  store.set(id, next);
  return next;
}

export function getDeployment(id: string): DeploymentView | null {
  const row = store.get(id);
  return row ? view({ ...row, queuePosition: queuePosition(id) }) : null;
}

export async function enqueueDeploy(input: {
  serverId: string;
  ruleSetVersion: string;
  approvalToken: string;
  initiatedBy: string;
  userId?: string;
}): Promise<DeploymentView> {
  const id = randomUUID();
  const row: DeploymentRecord = {
    id,
    serverId: input.serverId,
    state: "queued",
    queuePosition: 0,
    candidatePod: null,
    snapshotId: null,
    fromVersion: liveByServer.get(input.serverId) ?? null,
    toVersion: input.ruleSetVersion,
    error: null,
    startedAt: nowIso(),
    finishedAt: null,
    userId: input.userId ?? "unknown",
    namespace: null,
    liveDeployment: null,
    liveService: null,
  };
  store.set(id, row);
  enqueue(id);
  const admitted = admitNext();
  if (admitted === id) {
    void runMachine(id, input.approvalToken).catch((error) => {
      console.error(`[deploy ${id}] machine failed`, error);
    });
  }
  return getDeployment(id)!;
}

async function runMachine(id: string, approvalToken: string): Promise<void> {
  const row = store.get(id);
  if (!row) return;

  // building — no cluster objects yet. AuthClient forbids touching A.
  await transition(id, "building");
  redeemApprovalToken({
    token: approvalToken,
    serverId: row.serverId,
    expectedDigest: null,
  });
  const built = await buildRuleJar(readStaticRule());
  redeemApprovalToken({
    token: approvalToken,
    serverId: row.serverId,
    expectedDigest: built.contentDigest,
    alreadyRedeemed: true,
  });

  await transition(id, "staging");
  let candidate;
  try {
    await reserveDeploymentHeadroom(row.userId, row.serverId, id);
    candidate = await provisionCandidate({
      liveServerId: row.serverId,
      deploymentId: id,
      jarUrl: built.jarUrl,
    });
    await transition(id, "staging", {
      candidatePod: candidate.deploymentName,
      namespace: candidate.namespace,
      liveDeployment: candidate.liveDeploymentName,
      liveService: candidate.liveServiceName,
    });
  } catch (error) {
    await failAndAbort(id, error);
    return;
  }

  const auth = new AuthClient("pre-cutover");
  auth.assertCannotTouchA();

  await transition(id, "presync");
  // World stream is driven by the sidecar / receiver. Completeness, not
  // consistency, is required here.
  await transition(id, "freezing");
  await transition(id, "verifying");
  // M2 stops before cutover. Cutover is M3.
}

async function failAndAbort(id: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const row = store.get(id);
  if (!row) return;
  await abortDeployment(id, message);
}

export async function abortDeployment(id: string, error?: string): Promise<DeploymentView> {
  const row = store.get(id);
  if (!row) throw new Error("Deployment not found");
  if (row.state === "aborted" || row.state === "failed" || row.state === "idle") {
    return view(row);
  }
  if (row.state === "draining" || row.state === "cutover") {
    return view(row);
  }
  assertPreCutover(row);
  if (row.candidatePod && row.namespace) {
    await deleteCandidate({
      namespace: row.namespace,
      deploymentName: row.candidatePod,
      liveServerId: row.serverId,
      deploymentId: id,
    });
  }
  await releaseDeploymentHeadroom(id);
  complete(id);
  const next = await transition(id, "aborted", {
    error: error ?? "aborted",
    finishedAt: nowIso(),
    candidatePod: null,
  });
  const admitted = admitNext();
  if (admitted) {
    const nxt = store.get(admitted);
    if (nxt) {
      void runMachine(admitted, "dev-approval-token").catch((err) => {
        console.error(`[deploy ${admitted}] machine failed`, err);
      });
    }
  }
  return view(next);
}

export async function rollbackServer(serverId: string): Promise<DeploymentView> {
  const from = liveByServer.get(serverId);
  if (!from) throw new Error("No rollback target recorded for this server");
  return enqueueDeploy({
    serverId,
    ruleSetVersion: from,
    approvalToken: "dev-approval-token",
    initiatedBy: "rollback",
  });
}

export async function restoreServer(
  serverId: string,
  confirmDataLoss: string,
): Promise<{ ok: true }> {
  if (confirmDataLoss !== `restore ${serverId} and discard play since snapshot`) {
    throw new Error("Snapshot restore requires confirmDataLoss to name the data loss explicitly");
  }
  throw new Error("Snapshot restore is not wired until Engineer 3 lands snapshot_id");
}

export async function reconcileInFlight(): Promise<void> {
  for (const row of store.values()) {
    if (PRE_CUTOVER_STATES.includes(row.state as (typeof PRE_CUTOVER_STATES)[number])) {
      await abortDeployment(row.id, "reconciled after backend restart");
    }
  }
}

export async function completeCutover(id: string): Promise<void> {
  const row = store.get(id);
  if (!row) throw new Error("Deployment not found");
  if (row.state !== "verifying") {
    throw new Error(`cutover only from verifying, got ${row.state}`);
  }
  if (!row.liveService || !row.candidatePod) {
    throw new Error("missing route metadata for cutover");
  }
  const transferId = await issueTransfer({
    fromRoute: "lobby",
    toRoute: row.candidatePod,
    message: "Moving you into the new world…",
  });
  await waitForAck(transferId);
  const draining = new AuthClient("draining");
  draining.assertCanRetireA();
  liveByServer.set(row.serverId, row.toVersion ?? row.serverId);
  await transition(id, "draining");
  await transition(id, "idle", { finishedAt: nowIso() });
  await releaseDeploymentHeadroom(id);
}
