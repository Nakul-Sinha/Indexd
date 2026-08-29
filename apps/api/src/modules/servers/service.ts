import type * as k8s from "@kubernetes/client-node";
import { gameServers, serverConfigs, serverK8s, serverRoutes, userQuotas } from "@repo/db";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { status } from "elysia";
import { db, type TransactionType } from "../../db";
import { deleteGameServer, provisionGameServer } from "../provisioning";
import { makeKubernetesClients, waitForDeploymentReplicasReady } from "../provisioning/kubernetes";
import { calculateContainerMemory } from "../provisioning/utils";
import { QuotaService } from "../quota/quota.service";
import {
  type CreateServerInput,
  type ServerActionInput,
  serverActionDto,
  type UpdateServerConfigInput,
} from "./model";
import { getMinecraftRouteHostname } from "./routing";

const ACTIVE_SERVER_NAME_INDEX = "game_servers_user_active_name_idx";

function isActiveNameConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as {
    code?: string;
    constraint?: string;
    cause?: unknown;
  };

  if (candidate.code === "23505") {
    return candidate.constraint === ACTIVE_SERVER_NAME_INDEX;
  }

  if (candidate.cause) {
    return isActiveNameConflict(candidate.cause);
  }

  return false;
}

function buildIdBasedServerName(prefix: string, serverId: string): string {
  const slug = serverId.replace(/-/g, "").toLowerCase();
  return `${prefix}-${slug}`.slice(0, 50);
}

function buildRandomFallbackServerName(prefix: string): string {
  const slug = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${prefix}-${slug}`.slice(0, 50);
}

function buildRestoredServerName(originalName: string, serverId: string): string {
  const suffix = serverId.slice(0, 8);
  const restoredName = `${originalName}-restore-${suffix}`;

  if (restoredName.length <= 50) {
    return restoredName;
  }

  const prefixLength = 50 - "-restore-".length - suffix.length;
  return `${originalName.slice(0, Math.max(prefixLength, 1))}-restore-${suffix}`;
}

function buildRestoreNameCandidates(originalName: string, serverId: string): string[] {
  return [
    originalName,
    buildRestoredServerName(originalName, serverId),
    buildIdBasedServerName("restore", serverId),
    buildRandomFallbackServerName("restore"),
  ];
}

async function restoreServerAfterFailedDeletion(
  serverId: string,
  previousState: StateType,
  previousDesiredState: DesiredStateType,
) {
  const [server] = await db
    .select({ name: gameServers.name })
    .from(gameServers)
    .where(eq(gameServers.id, serverId))
    .limit(1);

  if (!server) return;

  const baseRestore = {
    currentState: previousState,
    desiredState: previousDesiredState,
    updatedAt: new Date(),
  };

  const renamedMessage =
    "Failed to delete server resources and the original name was taken. Server restored under a new name. Please contact support.";

  const candidates = buildRestoreNameCandidates(server.name, serverId);

  for (const [index, candidateName] of candidates.entries()) {
    try {
      await db
        .update(gameServers)
        .set({
          ...baseRestore,
          name: candidateName,
          statusMessage:
            index === 0
              ? "Failed to delete server resources. Please contact support."
              : renamedMessage,
        })
        .where(eq(gameServers.id, serverId));
      return;
    } catch (error) {
      if (!isActiveNameConflict(error)) {
        throw error;
      }
    }
  }

  // Last resort: keep generating random names until one succeeds.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await db
        .update(gameServers)
        .set({
          ...baseRestore,
          name: buildRandomFallbackServerName("restore"),
          statusMessage: renamedMessage,
        })
        .where(eq(gameServers.id, serverId));
      return;
    } catch (error) {
      if (!isActiveNameConflict(error)) {
        throw error;
      }
    }
  }

  throw status(
    500,
    "Failed to restore server state after an incomplete delete. Please contact support.",
  );
}

let cachedAppsApi: k8s.AppsV1Api | null = null;
function getAppsApi(): k8s.AppsV1Api {
  if (cachedAppsApi) return cachedAppsApi;

  try {
    // Reuse the provisioning client's EKS-aware TLS and authentication setup.
    // KubeConfig.makeApiClient() uses native fetch locally and fails to verify
    // the EKS certificate chain in this environment.
    cachedAppsApi = makeKubernetesClients().apps;
    return cachedAppsApi;
  } catch (err) {
    console.error("Failed to load Kubernetes client config:", err);
    throw status(503, "Kubernetes is not reachable right now. Please try again later.");
  }
}

type ServerState =
  | "ready"
  | "running"
  | "stopped"
  | "deleted"
  | "provisioning"
  | "starting"
  | "stopping"
  | "restarting"
  | "failed";

type DesiredServerState = "ready" | "running" | "stopped" | "deleted";

const VALID_FROM_STATES: Record<ServerActionInput["action"], readonly ServerState[]> = {
  start: ["stopped", "ready", "failed"] as const,
  stop: ["running", "starting", "failed"] as const,
  restart: ["running"] as const,
};

const TARGET_STATE: Record<ServerActionInput["action"], ServerState> = {
  start: "starting",
  stop: "stopping",
  restart: "restarting",
};

const DESIRED_STATE: Record<ServerActionInput["action"], DesiredServerState> = {
  start: "running",
  stop: "stopped",
  restart: "running",
};

const REPLICA_TARGET: Record<ServerActionInput["action"], number> = {
  start: 1,
  stop: 0,
  restart: 0,
};

const VALID_GAMES = ["minecraft", "rust", "cs2"] as const;
const VALID_STATES = [
  "ready",
  "running",
  "stopped",
  "deleted",
  "provisioning",
  "starting",
  "stopping",
  "restarting",
  "failed",
] as const;
const VALID_DESIRED_STATES = ["ready", "running", "stopped", "deleted"] as const;
type GameType = (typeof VALID_GAMES)[number];
type StateType = (typeof VALID_STATES)[number];
type DesiredStateType = (typeof VALID_DESIRED_STATES)[number];

export abstract class ServerService {
  private static readonly selection = {
    id: gameServers.id,
    name: gameServers.name,
    game: gameServers.game,
    currentState: gameServers.currentState,
    desiredState: gameServers.desiredState,
    statusMessage: gameServers.statusMessage,
    version: serverConfigs.version,
    cpuCores: serverConfigs.cpuCores,
    ramMb: serverConfigs.ramMb,
    storageGb: serverConfigs.storageGb,
    hostname: serverRoutes.hostname,
    ip: serverRoutes.ip,
    port: serverRoutes.port,
    createdAt: gameServers.createdAt,
    updatedAt: gameServers.updatedAt,
  };

  static async getAllByUser(userId: string) {
    return db
      .select(ServerService.selection)
      .from(gameServers)
      .leftJoin(serverConfigs, eq(serverConfigs.serverId, gameServers.id))
      .innerJoin(serverRoutes, eq(serverRoutes.serverId, gameServers.id))
      .where(and(eq(gameServers.userId, userId), ne(gameServers.currentState, "deleted")))
      .orderBy(desc(gameServers.createdAt));
  }

  static async getById(userId: string, serverId: string) {
    const [server] = await db
      .select(ServerService.selection)
      .from(gameServers)
      .leftJoin(serverConfigs, eq(serverConfigs.serverId, gameServers.id))
      .innerJoin(serverRoutes, eq(serverRoutes.serverId, gameServers.id))
      .where(and(eq(gameServers.id, serverId), eq(gameServers.userId, userId)))
      .limit(1);

    if (!server) throw status(404, "Server not found");
    return server;
  }

  static async hasOwnership(userId: string, serverId: string) {
    const server = await db.query.gameServers.findFirst({
      columns: { id: true },
      where: and(eq(gameServers.id, serverId), eq(gameServers.userId, userId)),
    });

    return Boolean(server);
  }

  static async getOwnerId(serverId: string) {
    const server = await db.query.gameServers.findFirst({
      columns: { userId: true },
      where: and(eq(gameServers.id, serverId), ne(gameServers.currentState, "deleted")),
    });

    if (!server) throw status(404, "Server not found");
    return server.userId;
  }

  static async requireOwnership(userId: string, serverId: string) {
    const [server] = await db
      .select({
        id: gameServers.id,
        currentState: gameServers.currentState,
        desiredState: gameServers.desiredState,
        statusMessage: gameServers.statusMessage,
      })
      .from(gameServers)
      .where(and(eq(gameServers.id, serverId), eq(gameServers.userId, userId)));
    if (!server) throw status(404, "Server not found");
    return server;
  }

  static async getInternalServers(game?: string, status?: string) {
    const validGame = VALID_GAMES.includes(game as GameType) ? (game as GameType) : undefined;
    const validState = status
      ? VALID_STATES.includes(status as StateType)
        ? (status as StateType)
        : undefined
      : "running";
    return db
      .select({
        name: gameServers.id,
        game: gameServers.game,
        status: gameServers.currentState,
        hostname: serverRoutes.hostname,
        // routingHostname: serverRoutes.hostname,
        proxyTarget: serverRoutes.proxyTarget,
        ip: serverRoutes.ip,
        port: serverRoutes.port,
      })
      .from(gameServers)
      .leftJoin(serverConfigs, eq(serverConfigs.serverId, gameServers.id))
      .innerJoin(serverRoutes, eq(serverRoutes.serverId, gameServers.id))
      .where(
        validGame && validState
          ? and(eq(gameServers.game, validGame), eq(gameServers.currentState, validState))
          : validGame
            ? eq(gameServers.game, validGame)
            : validState
              ? eq(gameServers.currentState, validState)
              : undefined,
      );
  }

  static async getK8sRecord(serverId: string) {
    const k8sRecord = await db.query.serverK8s.findFirst({
      where: eq(serverK8s.serverId, serverId),
    });
    if (!k8sRecord) throw status(404, "Server has no associated Kubernetes resources");
    return k8sRecord;
  }

  private static async claimTransition(
    userId: string,
    serverId: string,
    action: ServerActionInput["action"],
  ) {
    const validStates = VALID_FROM_STATES[action];
    const targetState = TARGET_STATE[action];
    const targetDesired = DESIRED_STATE[action];

    const [claimed] = await db
      .update(gameServers)
      .set({
        currentState: targetState,
        desiredState: targetDesired,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(gameServers.id, serverId),
          eq(gameServers.userId, userId),
          inArray(gameServers.currentState, validStates),
        ),
      )
      .returning({
        currentState: gameServers.currentState,
        desiredState: gameServers.desiredState,
      });

    if (claimed) return claimed;

    const exists = await db.query.gameServers.findFirst({
      columns: { id: true },
      where: and(eq(gameServers.id, serverId), eq(gameServers.userId, userId)),
    });

    if (!exists) throw status(404, "Server not found");

    throw status(409, `Cannot ${action} server: it is not in a valid state for this action`);
  }

  private static async setReplicas(
    appsApi: k8s.AppsV1Api,
    deploymentName: string,
    namespace: string,
    replicas: number,
  ) {
    return appsApi.patchNamespacedDeployment({
      name: deploymentName,
      namespace,
      body: [{ op: "replace", path: "/spec/replicas", value: replicas }],
      fieldManager: "farlands-backend",
    });
  }

  private static async triggerRollingRestart(deploymentName: string, namespace: string) {
    const appsApi = getAppsApi();
    await appsApi.patchNamespacedDeployment({
      name: deploymentName,
      namespace,
      body: [
        {
          op: "add",
          path: "/spec/template/metadata/annotations",
          value: {
            "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
          },
        },
      ],
      fieldManager: "farlands-backend",
    });
  }

  private static async settleState(
    serverId: string,
    currentState: "running" | "stopped",
    desiredState: "running" | "stopped",
  ) {
    await db
      .update(gameServers)
      .set({ currentState, desiredState, updatedAt: new Date() })
      .where(eq(gameServers.id, serverId));
  }

  private static async rollbackToPreviousState(
    serverId: string,
    previousState: {
      currentState: ServerState;
      desiredState: DesiredServerState;
    },
  ) {
    try {
      await db
        .update(gameServers)
        .set({
          currentState: previousState.currentState,
          desiredState: previousState.desiredState,
          updatedAt: new Date(),
        })
        .where(eq(gameServers.id, serverId));
    } catch (updateErr) {
      console.error(`[${serverId}] Failed to roll back to previous state:`, updateErr);
    }
  }

  private static async rollbackToStopped(serverId: string) {
    try {
      await db
        .update(gameServers)
        .set({
          currentState: "stopped",
          desiredState: "stopped",
          updatedAt: new Date(),
        })
        .where(eq(gameServers.id, serverId));
    } catch (updateErr) {
      console.error(`[${serverId}] Failed to roll back to stopped:`, updateErr);
    }
  }
  private static async patchDeploymentResources(
    deploymentName: string,
    namespace: string,
    cpuCores: string,
    ramMb: number,
  ) {
    const appsApi = getAppsApi();
    const containerMemory = calculateContainerMemory(ramMb);
    const quantities = { cpu: cpuCores, memory: `${containerMemory}Mi` };
    return appsApi.patchNamespacedDeployment({
      name: deploymentName,
      namespace,
      body: [
        {
          op: "replace",
          path: "/spec/template/spec/containers/0/resources",
          value: { requests: quantities, limits: quantities },
        },
      ],
      fieldManager: "farlands-backend",
    });
  }
  private static async patchConfigMap(
    configMapName: string,
    namespace: string,
    gameConfigJson: NonNullable<UpdateServerConfigInput["gameConfigJson"]>,
  ) {
    const coreApi = makeKubernetesClients().core;
    const data: Record<string, string> = {};

    if (gameConfigJson.maxPlayers !== undefined)
      data.MAX_PLAYERS = String(gameConfigJson.maxPlayers);
    if (gameConfigJson.difficulty !== undefined) data.DIFFICULTY = gameConfigJson.difficulty;
    if (gameConfigJson.pvp !== undefined) data.PVP = String(gameConfigJson.pvp);
    if (gameConfigJson.motd !== undefined) data.MOTD = gameConfigJson.motd;
    if (gameConfigJson.seed !== undefined) data.SEED = gameConfigJson.seed;

    const patches = Object.entries(data).map(([key, value]) => ({
      op: "add",
      path: `/data/${key}`,
      value,
    }));

    return coreApi.patchNamespacedConfigMap({
      name: configMapName,
      namespace,
      body: patches,
      fieldManager: "farlands-backend",
    });
  }

  private static async patchPvcSize(_pvcName: string, _namespace: string, _storageGb: number) {
    // TODO: confirm farlands-gp3 has allowVolumeExpansion: true before enabling.
    throw new Error("Storage size increases are not yet supported. Contact an admin.");
  }

  static async updateServerConfig(serverId: string, userId: string, data: UpdateServerConfigInput) {
    await this.requireOwnership(userId, serverId);
    const k8sRecord = await this.getK8sRecord(serverId);

    // Snapshot current config — needed to revert if K8s patch fails.
    const [previousConfig] = await db
      .select()
      .from(serverConfigs)
      .where(eq(serverConfigs.serverId, serverId))
      .limit(1);

    if (!previousConfig) throw status(404, "Server configuration not found");

    const newCpuCores = data.cpuCores ?? Number(previousConfig.cpuCores);
    const newRamMb = data.ramMb ?? previousConfig.ramMb;
    const newStorageGb = data.storageGb ?? previousConfig.storageGb;

    // Storage can be increased but not shrunk — PVCs are immutable in that direction.
    if (newStorageGb < previousConfig.storageGb) {
      throw status(
        400,
        `Storage cannot be reduced. Current size is ${previousConfig.storageGb}GB.`,
      );
    }

    if (newStorageGb > previousConfig.storageGb) {
      throw status(400, "Storage increases are not yet supported.");
    }

    const [quotaRow] = await db
      .select()
      .from(userQuotas)
      .where(eq(userQuotas.userId, userId))
      .limit(1);
    if (!quotaRow) throw status(404, "No quota found for this account.");

    if (newCpuCores > Number(quotaRow.cpuLimit)) {
      throw status(
        403,
        `CPU limit exceeded. Your plan allows ${quotaRow.cpuLimit} cores per server.`,
      );
    }
    if (newRamMb > quotaRow.ramLimitMb) {
      throw status(
        403,
        `RAM limit exceeded. Your plan allows ${quotaRow.ramLimitMb}MB per server.`,
      );
    }
    if (newStorageGb > quotaRow.storageLimitGb) {
      throw status(
        403,
        `Storage limit exceeded. Your plan allows ${quotaRow.storageLimitGb}GB per server.`,
      );
    }

    await db
      .update(serverConfigs)
      .set({
        cpuCores: String(newCpuCores),
        ramMb: newRamMb,
        storageGb: newStorageGb,
        gameConfigJson: data.gameConfigJson
          ? {
              ...(previousConfig.gameConfigJson as Record<string, unknown>),
              ...data.gameConfigJson,
            }
          : previousConfig.gameConfigJson,
        updatedAt: new Date(),
      })
      .where(eq(serverConfigs.serverId, serverId));

    // Apply to K8s. If anything fails, revert the DB write above.
    try {
      if (data.cpuCores !== undefined || data.ramMb !== undefined) {
        await this.patchDeploymentResources(
          k8sRecord.deploymentName,
          k8sRecord.namespace,
          String(newCpuCores),
          newRamMb,
        );
      }

      if (data.gameConfigJson !== undefined) {
        await this.patchConfigMap(
          `cm-server-${serverId}`,
          k8sRecord.namespace,
          data.gameConfigJson,
        );
      }

      // Trigger rolling restart so config changes take effect without manual intervention.
      await this.triggerRollingRestart(k8sRecord.deploymentName, k8sRecord.namespace);

      return { success: true, message: "Server configuration updated" };
    } catch (error) {
      console.error(`[${serverId}] K8s config patch failed, reverting server_configs:`, error);

      // Revert DB to the snapshot taken before the update.
      await db
        .update(serverConfigs)
        .set({
          cpuCores: previousConfig.cpuCores,
          ramMb: previousConfig.ramMb,
          storageGb: previousConfig.storageGb,
          gameConfigJson: previousConfig.gameConfigJson,
          updatedAt: new Date(),
        })
        .where(eq(serverConfigs.serverId, serverId));

      throw status(500, "Failed to apply configuration change to server.");
    }
  }

  static async performAction(serverId: string, userId: string, data: ServerActionInput) {
    const { action } = serverActionDto.parse(data);
    let previousState = await this.requireOwnership(userId, serverId);

    if (
      previousState.currentState === "restarting" &&
      previousState.desiredState === "stopped" &&
      previousState.statusMessage === "Restoring backup"
    ) {
      // A backend restart can interrupt the in-process restore monitor after
      // Kubernetes has already finished. Recover that durable Job state before
      // deciding whether a new power action is valid.
      const { BackupService } = await import("../backup/service");
      await BackupService.reconcileServerOperations(serverId);
      previousState = await this.requireOwnership(userId, serverId);
    }

    // Validate quota before claiming the transition if reactivating a failed server.
    // Failed servers are excluded from quota, so restoring them requires validation.
    if ((action === "restart" || action === "start") && previousState.currentState === "failed") {
      await QuotaService.validateRestartQuota(userId, serverId);
    }

    await this.claimTransition(userId, serverId, action);

    const k8sRecord = await this.getK8sRecord(serverId);
    const { deploymentName, namespace } = k8sRecord;
    const appsApi = getAppsApi();

    if (action === "restart") {
      let scaledDown = false;
      try {
        await this.setReplicas(appsApi, deploymentName, namespace, 0);
        scaledDown = true;

        await waitForDeploymentReplicasReady(appsApi, deploymentName, namespace, 0);

        await this.setReplicas(appsApi, deploymentName, namespace, 1);
        await db
          .update(gameServers)
          .set({ currentState: "starting", updatedAt: new Date() })
          .where(eq(gameServers.id, serverId));

        await waitForDeploymentReplicasReady(appsApi, deploymentName, namespace, 1);
        await this.settleState(serverId, "running", "running");

        return { success: true, action, status: "running" };
      } catch (err) {
        console.error(`[${serverId}] Failed to perform ${action}:`, err);

        if (!scaledDown) {
          await this.rollbackToPreviousState(serverId, previousState);
          throw status(500, `Failed to ${action} server`);
        }

        try {
          await this.setReplicas(appsApi, deploymentName, namespace, 0);
        } catch (compensateErr) {
          console.error(
            `[${serverId}] Failed to compensate with scale-down after restart error:`,
            compensateErr,
          );
        }
        await this.rollbackToStopped(serverId);
        throw status(500, `Failed to ${action} server`);
      }
    }

    // start / stop
    const replicas = REPLICA_TARGET[action];
    const finalState = action === "start" ? "running" : "stopped";

    try {
      await this.setReplicas(appsApi, deploymentName, namespace, replicas);
      await waitForDeploymentReplicasReady(appsApi, deploymentName, namespace, replicas);
      await this.settleState(serverId, finalState, finalState);

      return { success: true, action, status: finalState };
    } catch (err) {
      console.error(`[${serverId}] Failed to perform ${action}:`, err);

      try {
        const deployment = await appsApi.readNamespacedDeployment({
          name: deploymentName,
          namespace,
        });
        const liveReplicas = deployment.status?.readyReplicas ?? 0;
        const liveState = liveReplicas > 0 ? "running" : "stopped";
        await this.settleState(serverId, liveState, liveState);
      } catch (reconcileErr) {
        console.error(
          `[${serverId}] Failed to reconcile live K8s state after ${action} error:`,
          reconcileErr,
        );
        await this.rollbackToPreviousState(serverId, previousState);
      }

      throw status(500, `Failed to ${action} server`);
    }
  }

  static async getStatus(serverId: string, userId: string) {
    const server = await this.requireOwnership(userId, serverId);
    const k8sRecord = await this.getK8sRecord(serverId);

    let liveReplicas: number | null = null;
    try {
      const appsApi = getAppsApi();
      const deployment = await appsApi.readNamespacedDeployment({
        name: k8sRecord.deploymentName,
        namespace: k8sRecord.namespace,
      });
      liveReplicas = deployment.status?.readyReplicas ?? 0;
    } catch (err) {
      console.error(`[${serverId}] Failed to read live deployment status:`, err);
    }

    return {
      currentState: server.currentState,
      desiredState: server.desiredState,
      deploymentName: k8sRecord.deploymentName,
      namespace: k8sRecord.namespace,
      liveReplicas,
    };
  }

  static async create(userId: string, data: CreateServerInput) {
    const serverId = crypto.randomUUID();
    const routeHostname = getMinecraftRouteHostname(serverId);
    try {
      await db.transaction(async (tx: TransactionType) => {
        const quota = await QuotaService.getResourceLimits(userId, tx);
        if (!quota) {
          throw status(404, "No quota found for this account.");
        }

        const projectedServers = quota.serversUsed + 1;
        // Check limits for the server
        if (projectedServers > quota.serversLimit) {
          throw status(
            403,
            `Server limit exceeded. Your plan allows ${quota.serversLimit} servers.`,
          );
        }
        if (data.cpuCores > Number(quota.cpuLimit)) {
          throw status(
            403,
            `CPU limit exceeded. You have ${Number(quota.cpuLimit)} cores available.`,
          );
        }
        if (data.ramMb > quota.ramLimitMb) {
          throw status(403, `RAM limit exceeded. You have ${quota.ramLimitMb}MB available.`);
        }
        if (data.storageGb > quota.storageLimitGb) {
          throw status(
            403,
            `Storage limit exceeded. You have ${quota.storageLimitGb}GB available.`,
          );
        }

        await tx.insert(gameServers).values({
          id: serverId,
          userId: userId,
          name: data.name,
          game: data.game,
          currentState: "provisioning",
          desiredState: "ready",
        });

        await tx.insert(serverConfigs).values({
          id: crypto.randomUUID(),
          serverId: serverId,
          version: data.version,
          type: data.type,
          gameConfigJson: data.gameConfigJson,
          cpuCores: String(data.cpuCores),
          ramMb: data.ramMb,
          storageGb: data.storageGb,
          storageClass: "farlands-gp3",
        });

        await tx.insert(serverRoutes).values({
          id: crypto.randomUUID(),
          serverId: serverId,
          hostname: routeHostname,
          proxyTarget: null,
          ip: null,
          port: 25565,
        });

        //TODO: Log server creation
        console.info(`[${serverId}] Initial database records created for new game server`);
      });
    } catch (error) {
      if (isActiveNameConflict(error)) {
        throw status(409, `A server named "${data.name}" already exists.`);
      }
      throw error;
    }

    try {
      //TODO: send config data to provision service
      const isProvisioned = await provisionGameServer(serverId);

      if (!isProvisioned) {
        throw status(500, "Kubernetes provisioning failed or was rolled back.");
      }

      console.info(`[${serverId}] Server successfully provisioned on EKS`);
      return serverId;
    } catch (error) {
      console.error(`[${serverId}] Failed to provision server:`, error);
      // Failed server should be available for retry or must be deleted.
      await db
        .update(gameServers)
        .set({ currentState: "failed" })
        .where(eq(gameServers.id, serverId));
      throw error;
    }
  }

  static async delete(userId: string, serverId: string) {
    let previousState: StateType;
    let previousDesiredState: DesiredStateType;
    await db.transaction(async (tx: TransactionType) => {
      const [server] = await tx
        .select({
          id: gameServers.id,
          currentState: gameServers.currentState,
          desiredState: gameServers.desiredState,
        })
        .from(gameServers)
        .where(and(eq(gameServers.id, serverId), eq(gameServers.userId, userId)))
        .for("update");

      if (!server) throw status(404, "Server not found");

      if (server.currentState === "deleted" || server.currentState === "provisioning") {
        throw status(409, `Cannot delete server in state: ${server.currentState}`);
      }
      previousState = server.currentState;
      previousDesiredState = server.desiredState;
      // TODO: create a current state named "deleting"
      // Setting the current state to deleted early for now.
      await tx
        .update(gameServers)
        .set({
          currentState: "deleted",
          desiredState: "deleted",
          updatedAt: new Date(),
        })
        .where(eq(gameServers.id, serverId));
    });

    try {
      console.info(`[${serverId}] Initiating Kubernetes teardown...`);

      const k8sCleaned = await deleteGameServer(serverId);

      if (!k8sCleaned) {
        throw new Error("One or more Kubernetes resources failed to delete.");
      }
      await db
        .update(gameServers)
        .set({
          currentState: "deleted",
          updatedAt: new Date(),
        })
        .where(eq(gameServers.id, serverId));

      console.info(`[${serverId}] Server fully deleted from system`);
      return { deletedServerId: serverId };
    } catch (error) {
      console.error(`[${serverId}] Deletion process failed:`, error);

      await restoreServerAfterFailedDeletion(serverId, previousState!, previousDesiredState!);

      throw status(500, "Failed to fully delete server resources.");
    }
  }
}
