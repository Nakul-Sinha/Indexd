import type * as k8s from "@kubernetes/client-node";
import { gameServers, serverConfigs, serverK8s, serverRoutes } from "@repo/db/schema";
import { and, eq } from "drizzle-orm";
// Kept for future use.
import type { z } from "zod";
import { db } from "../../db";
import {
  CLUSTER_NAME,
  getKubernetesStatusCode,
  type KubernetesClients,
  makeKubernetesClients,
  waitForDeploymentReplicasReady,
} from "./kubernetes";
import {
  ensureTenantNamespace,
  RCON_PASSWORD_FILE,
  RCON_PORT,
  RCON_SECRET_NAME,
  WORLD_SYNC_PORT,
} from "./tenancy";
import { calculateContainerMemory, MinecraftUtils } from "./utils";

const TEST_EXISTING_PVC_NAME = process.env.FARLANDS_TEST_EXISTING_PVC_NAME;
const TEST_WORKLOAD_REPLICAS =
  TEST_EXISTING_PVC_NAME && process.env.FARLANDS_TEST_START_POD !== "true" ? 0 : 1;
const SERVER_PORT = 25565;
const DATA_MOUNT_PATH = "/data";
const SUPPORTED_RUNTIMES: Record<string, string[]> = {
  minecraft: ["vanilla", "paper", "fabric", "forge", "purpur"],
};
const VELOCITY_SECRET_NAME =
  process.env.FARLANDS_VELOCITY_SECRET_NAME ?? "velocity-forwarding-secret";
const VELOCITY_SECRET_KEY = process.env.FARLANDS_VELOCITY_SECRET_KEY ?? "forwarding.secret";

type ProvisionedResource =
  | "networkPolicy"
  | "service"
  | "deployment"
  | "configMap"
  | "filesConfigMap"
  | "pvc";

type ServerResourceNames = {
  pvc: string;
  deployment: string;
  service: string;
  configMap: string;
  filesConfigMap: string;
  networkPolicy: string;
};

type ResourceExistenceCheck = {
  resource: ProvisionedResource;
  name: string;
  read: () => Promise<unknown>;
};

type ResourceSpec = {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
};

// Fetched internally from serverConfigs/gameServers by serverId — see
// getProvisionConfig(). Replaces the earlier approach of taking this as
// a function parameter from the caller.
type ProvisionConfig = {
  game: string;
  // vanilla | paper | fabric | forge | purpur — assumed column on
  // serverConfigs, confirm exact column name once PR #44 merges.
  type: string;
  version: string;
  cpuCores: string; // stored as text in serverConfigs
  ramMb: number;
  storageGb: number;
  storageClass: string;
  gameConfigJson: {
    maxPlayers: number;
    difficulty: "peaceful" | "easy" | "normal" | "hard";
    pvp: boolean;
    motd?: string;
    seed?: string;
    loaderVersion?: string;
  };
};

function getServerResourceNames(serverId: string): ServerResourceNames {
  return {
    pvc: TEST_EXISTING_PVC_NAME ?? `pvc-server-${serverId}`,
    deployment: `deploy-server-${serverId}`,
    service: `svc-server-${serverId}`,
    configMap: `cm-server-${serverId}`,
    filesConfigMap: `cm-server-${serverId}-files`,
    networkPolicy: `netpol-server-${serverId}`,
  };
}

function validateKubernetesNameSegment(value: string, fieldName: string): void {
  const dnsLabel = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

  if (!dnsLabel.test(value) || value.length > 40) {
    throw new Error(
      `${fieldName} must be a lowercase Kubernetes DNS label segment up to 40 characters`,
    );
  }
}

// Guaranteed QoS: requests == limits, so the pod always gets exactly what
// was requested and is never throttled below it. cpuCores arrives as text
// from serverConfigs (e.g. "1", "1.5", "2") — k8s accepts a plain numeric
// string as a CPU quantity directly, so no conversion is needed.
function buildResourceSpec(cpuCores: string, ramMb: number): ResourceSpec {
  const containerMemory = calculateContainerMemory(ramMb);
  const quantities = {
    cpu: cpuCores,
    memory: `${containerMemory}Mi`,
  };

  return { requests: quantities, limits: quantities };
}

function buildLabels(serverId: string, runtime: string): Record<string, string> {
  return {
    "app.kubernetes.io/name": "farlands-game-server",
    "app.kubernetes.io/managed-by": "farlands-backend",
    "farlands.dev/server-id": serverId,
    "farlands.dev/runtime": runtime,
  };
}

function buildPvc(
  namespace: string,
  names: ServerResourceNames,
  labels: Record<string, string>,
  storageGb: number,
  storageClass: string,
): k8s.V1PersistentVolumeClaim {
  return {
    metadata: {
      name: names.pvc,
      namespace,
      labels,
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: storageClass,
      resources: {
        requests: {
          storage: `${storageGb}Gi`,
        },
      },
    },
  };
}

function buildConfigMap(
  namespace: string,
  names: ServerResourceNames,
  labels: Record<string, string>,
  config: ProvisionConfig,
): k8s.V1ConfigMap {
  const { type, version, gameConfigJson } = config;

  const data: Record<string, string> = {
    EULA: "true",
    ENABLE_RCON: "true",
    RCON_PASSWORD_FILE,
    ONLINE_MODE: "false",
    SERVER_PORT: SERVER_PORT.toString(),
    TYPE: type.toUpperCase(),
    VERSION: version,
    MAX_PLAYERS: gameConfigJson.maxPlayers.toString(),
    DIFFICULTY: gameConfigJson.difficulty,
    PVP: gameConfigJson.pvp.toString(),
    REPLACE_ENV_DURING_SYNC: "true",
    ENV_VARIABLE_PREFIX: "CFG_",
    SYNC_SKIP_NEWER_IN_DESTINATION: "false",
  };

  if (gameConfigJson.motd) {
    data.MOTD = gameConfigJson.motd;
  }

  if (gameConfigJson.seed) {
    data.SEED = gameConfigJson.seed;
  }

  // superRefine on the zod schema already guarantees loaderVersion is present
  // when type is fabric/forge — confirmed FABRIC_LOADER_VERSION / FORGE_VERSION
  // against the official itzg/docker-minecraft-server docs.
  if (type === "fabric" || type === "forge") {
    if (!gameConfigJson.loaderVersion) {
      throw new Error(
        `loaderVersion is required in gameConfigJson for runtime type "${type}" but was not found`,
      );
    }
    if (type === "fabric") {
      data.FABRIC_LOADER_VERSION = gameConfigJson.loaderVersion;
    }
    if (type === "forge") {
      data.FORGE_VERSION = gameConfigJson.loaderVersion;
    }
  }

  return {
    metadata: {
      name: names.configMap,
      namespace,
      labels,
    },
    data,
  };
}

function buildPaperGlobalConfigMap(
  namespace: string,
  names: ServerResourceNames,
  labels: Record<string, string>,
): k8s.V1ConfigMap {
  const paperGlobalYml = `proxies:
  velocity:
    enabled: true
    online-mode: true
    secret: "\${CFG_VELOCITY_SECRET}"
`;

  return {
    metadata: {
      name: names.filesConfigMap,
      namespace,
      labels,
    },
    data: {
      "paper-global.yml": paperGlobalYml,
    },
  };
}

function buildDeployment(
  namespace: string,
  names: ServerResourceNames,
  labels: Record<string, string>,
  image: string,
  resources: ResourceSpec,
): k8s.V1Deployment {
  return {
    metadata: {
      name: names.deployment,
      namespace,
      labels,
    },
    spec: {
      replicas: TEST_WORKLOAD_REPLICAS,
      selector: {
        matchLabels: {
          "farlands.dev/server-id": labels["farlands.dev/server-id"],
        },
      },
      template: {
        metadata: {
          labels,
        },
        spec: {
          tolerations: [
            {
              key: "farlands.sh/nodepool",
              operator: "Equal",
              value: "infra-team-autoscale",
              effect: "NoSchedule",
            },
          ],
          containers: [
            {
              name: "game-server",
              image,
              imagePullPolicy: "IfNotPresent",
              ports: [
                {
                  name: "minecraft",
                  containerPort: SERVER_PORT,
                  protocol: "TCP",
                },
                {
                  name: "rcon",
                  containerPort: RCON_PORT,
                  protocol: "TCP",
                },
              ],
              startupProbe: {
                tcpSocket: {
                  port: SERVER_PORT,
                },
                failureThreshold: 30,
                periodSeconds: 10,
              },
              livenessProbe: {
                tcpSocket: {
                  port: SERVER_PORT,
                },
                initialDelaySeconds: 20,
                periodSeconds: 15,
                timeoutSeconds: 10,
                failureThreshold: 5,
              },
              readinessProbe: {
                tcpSocket: {
                  port: SERVER_PORT,
                },
                initialDelaySeconds: 15,
                periodSeconds: 10,
                timeoutSeconds: 5,
                failureThreshold: 3,
              },
              envFrom: [
                {
                  configMapRef: {
                    name: names.configMap,
                  },
                },
              ],
              env: [
                {
                  name: "CFG_VELOCITY_SECRET",
                  valueFrom: {
                    secretKeyRef: {
                      name: VELOCITY_SECRET_NAME,
                      key: VELOCITY_SECRET_KEY,
                    },
                  },
                },
              ],
              resources,
              volumeMounts: [
                {
                  name: "server-data",
                  mountPath: DATA_MOUNT_PATH,
                },
                {
                  name: "paper-global-config",
                  mountPath: "/config/paper-global.yml",
                  subPath: "paper-global.yml",
                },
                {
                  name: "rcon",
                  mountPath: "/run/secrets/rcon",
                  readOnly: true,
                },
              ],
            },
            {
              name: "world-sync",
              image: "python:3.12-alpine",
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "-c", "apk add --no-cache tar >/dev/null && python3 /sync/sender.py"],
              ports: [
                {
                  name: "world-sync",
                  containerPort: WORLD_SYNC_PORT,
                  protocol: "TCP",
                },
              ],
              env: [
                { name: "WORLD_SYNC_PORT", value: String(WORLD_SYNC_PORT) },
                { name: "WORLD_ROOT", value: `${DATA_MOUNT_PATH}/world` },
              ],
              resources: {
                requests: { cpu: "50m", memory: "64Mi" },
                limits: { cpu: "200m", memory: "128Mi" },
              },
              volumeMounts: [
                { name: "server-data", mountPath: DATA_MOUNT_PATH },
                { name: "world-sync", mountPath: "/sync" },
              ],
            },
          ],
          volumes: [
            {
              name: "server-data",
              persistentVolumeClaim: {
                claimName: names.pvc,
              },
            },
            {
              name: "paper-global-config",
              configMap: { name: names.filesConfigMap },
            },
            {
              name: "world-sync",
              configMap: { name: "cm-world-sync" },
            },
            {
              name: "rcon",
              secret: { secretName: RCON_SECRET_NAME },
            },
          ],
        },
      },
    },
  };
}

function buildService(
  namespace: string,
  names: ServerResourceNames,
  labels: Record<string, string>,
): k8s.V1Service {
  return {
    metadata: {
      name: names.service,
      namespace,
      labels,
    },
    spec: {
      type: "ClusterIP",
      selector: {
        "farlands.dev/server-id": labels["farlands.dev/server-id"],
      },
      ports: [
        {
          name: "minecraft",
          port: SERVER_PORT,
          targetPort: SERVER_PORT,
          protocol: "TCP",
        },
        {
          name: "rcon",
          port: RCON_PORT,
          targetPort: RCON_PORT,
          protocol: "TCP",
        },
        {
          name: "world-sync",
          port: WORLD_SYNC_PORT,
          targetPort: WORLD_SYNC_PORT,
          protocol: "TCP",
        },
      ],
    },
  };
}

function buildNetworkPolicy(
  namespace: string,
  names: ServerResourceNames,
  labels: Record<string, string>,
): k8s.V1NetworkPolicy {
  const sharedFrom = {
    namespaceSelector: {
      matchLabels: { "farlands.dev/shared": "true" },
    },
  };

  return {
    metadata: {
      name: names.networkPolicy,
      namespace,
      labels,
    },
    spec: {
      podSelector: {
        matchLabels: {
          "farlands.dev/server-id": labels["farlands.dev/server-id"],
        },
      },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "infra-team" },
              },
              podSelector: { matchLabels: { app: "velocity-proxy" } },
            },
            sharedFrom,
          ],
          ports: [{ protocol: "TCP", port: SERVER_PORT }],
        } as unknown as k8s.V1NetworkPolicyIngressRule,
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: {
                  "kubernetes.io/metadata.name": "dev-deployment",
                },
              },
              podSelector: { matchLabels: { app: "farlands-backend" } },
            },
            sharedFrom,
          ],
          ports: [{ protocol: "TCP", port: RCON_PORT }],
        } as unknown as k8s.V1NetworkPolicyIngressRule,
        {
          from: [{ podSelector: {} }],
          ports: [{ protocol: "TCP", port: WORLD_SYNC_PORT }],
        } as unknown as k8s.V1NetworkPolicyIngressRule,
      ],
    },
  };
}

async function ensureProvisioningResourcesDoNotExist(
  clients: KubernetesClients,
  names: ServerResourceNames,
  namespace: string,
): Promise<void> {
  const checks: ResourceExistenceCheck[] = [
    {
      resource: "configMap",
      name: names.configMap,
      read: () =>
        clients.core.readNamespacedConfigMap({
          name: names.configMap,
          namespace: namespace,
        }),
    },
    {
      resource: "filesConfigMap",
      name: names.filesConfigMap,
      read: () =>
        clients.core.readNamespacedConfigMap({
          name: names.filesConfigMap,
          namespace: namespace,
        }),
    },
    {
      resource: "deployment",
      name: names.deployment,
      read: () =>
        clients.apps.readNamespacedDeployment({
          name: names.deployment,
          namespace: namespace,
        }),
    },
    {
      resource: "service",
      name: names.service,
      read: () =>
        clients.core.readNamespacedService({
          name: names.service,
          namespace: namespace,
        }),
    },
    {
      resource: "networkPolicy",
      name: names.networkPolicy,
      read: () =>
        clients.networking.readNamespacedNetworkPolicy({
          name: names.networkPolicy,
          namespace: namespace,
        }),
    },
  ];

  if (!TEST_EXISTING_PVC_NAME) {
    checks.unshift({
      resource: "pvc",
      name: names.pvc,
      read: () =>
        clients.core.readNamespacedPersistentVolumeClaim({
          name: names.pvc,
          namespace: namespace,
        }),
    });
  }

  for (const check of checks) {
    try {
      await check.read();
      throw new Error(
        `${check.resource} ${check.name} already exists in ${namespace}; refusing to reprovision over existing resources`,
      );
    } catch (error) {
      if (getKubernetesStatusCode(error) === 404) {
        continue;
      }

      throw error;
    }
  }
}

async function rollbackProvisionedResources(
  clients: KubernetesClients,
  names: ServerResourceNames,
  createdResources: ProvisionedResource[],
  namespace: string,
): Promise<void> {
  const deleteHandlers: Record<ProvisionedResource, () => Promise<unknown>> = {
    networkPolicy: () =>
      clients.networking.deleteNamespacedNetworkPolicy({
        name: names.networkPolicy,
        namespace: namespace,
      }),
    service: () =>
      clients.core.deleteNamespacedService({
        name: names.service,
        namespace: namespace,
      }),
    deployment: () =>
      clients.apps.deleteNamespacedDeployment({
        name: names.deployment,
        namespace: namespace,
      }),
    configMap: () =>
      clients.core.deleteNamespacedConfigMap({
        name: names.configMap,
        namespace: namespace,
      }),
    filesConfigMap: () =>
      clients.core.deleteNamespacedConfigMap({
        name: names.filesConfigMap,
        namespace: namespace,
      }),
    pvc: () =>
      clients.core.deleteNamespacedPersistentVolumeClaim({
        name: names.pvc,
        namespace: namespace,
      }),
  };

  const deletionErrors: unknown[] = [];

  for (const resource of [...createdResources].reverse()) {
    try {
      await deleteHandlers[resource]();
    } catch (error) {
      const statusCode = getKubernetesStatusCode(error);

      if (statusCode !== 404) {
        deletionErrors.push(error);
      }
    }
  }

  if (deletionErrors.length > 0) {
    console.error(
      `[${names.deployment}] Rollback completed with ${deletionErrors.length} deletion error(s)`,
      deletionErrors,
    );
  }
}

async function deleteKubernetesResources(
  clients: KubernetesClients,
  names: ServerResourceNames,
  namespace: string,
): Promise<void> {
  const deleteHandlers = {
    networkPolicy: () =>
      clients.networking.deleteNamespacedNetworkPolicy({
        name: names.networkPolicy,
        namespace,
      }),

    service: () =>
      clients.core.deleteNamespacedService({
        name: names.service,
        namespace,
      }),

    deployment: () =>
      clients.apps.deleteNamespacedDeployment({
        name: names.deployment,
        namespace,
      }),

    configMap: () =>
      clients.core.deleteNamespacedConfigMap({
        name: names.configMap,
        namespace,
      }),

    filesConfigMap: () =>
      clients.core.deleteNamespacedConfigMap({
        name: names.filesConfigMap,
        namespace,
      }),

    pvc: () =>
      clients.core.deleteNamespacedPersistentVolumeClaim({
        name: names.pvc,
        namespace,
      }),
  };

  const deletionOrder = ["networkPolicy", "service", "deployment", "configMap", "pvc"] as const;

  for (const resource of deletionOrder) {
    try {
      await deleteHandlers[resource]();
    } catch (error) {
      const statusCode = getKubernetesStatusCode(error);

      if (statusCode !== 404) {
        throw error;
      }
    }
  }
}

async function persistProvisioningState(
  serverId: string,
  names: ServerResourceNames,
  namespace: string,
): Promise<void> {
  // Compatibility bridge for lifecycle/schema PR #34, which renames
  // statefulSetName to deploymentName. Remove the fallback after that PR lands.
  const serverK8sValues = {
    id: crypto.randomUUID(),
    serverId,
    deploymentName: names.deployment,
    namespace: namespace,
    serviceName: names.service,
    clusterName: CLUSTER_NAME,
    pvcName: names.pvc,
    extraEnv: [
      { name: "EULA", value: "true" },
      { name: "ENABLE_RCON", value: "true" },
      { name: "ONLINE_MODE", value: "false" },
      { name: "SERVER_PORT", value: SERVER_PORT.toString() },
    ],
  } satisfies typeof serverK8s.$inferInsert;

  const serverK8sUpdateValues = {
    deploymentName: names.deployment,
    namespace: namespace,
    serviceName: names.service,
    podName: null,
    clusterName: CLUSTER_NAME,
    pvcName: names.pvc,
    extraEnv: [
      { name: "EULA", value: "true" },
      { name: "ENABLE_RCON", value: "true" },
      { name: "ONLINE_MODE", value: "false" },
      { name: "SERVER_PORT", value: SERVER_PORT.toString() },
    ],
    generatedYaml: null,
    yamlGeneratedAt: null,
  } as Partial<typeof serverK8s.$inferInsert>;

  await db.transaction(async (tx) => {
    const [updatedServer] = await tx
      .update(gameServers)
      .set({
        currentState: "running",
        desiredState: "running",
        statusMessage: "Server provisioned and started successfully.",
      })
      .where(and(eq(gameServers.id, serverId), eq(gameServers.currentState, "provisioning")))
      .returning({ id: gameServers.id });

    if (!updatedServer) {
      throw new Error(
        `Cannot persist Kubernetes resources because game server ${serverId} does not exist or is not provisioning`,
      );
    }

    await tx.insert(serverK8s).values(serverK8sValues).onConflictDoUpdate({
      target: serverK8s.serverId,
      set: serverK8sUpdateValues,
    });

    await tx
      .insert(serverRoutes)
      .values({
        id: crypto.randomUUID(),
        serverId,
        hostname: null,
        proxyTarget: `${names.service}.${namespace}.svc.cluster.local`,
        ip: null,
        port: SERVER_PORT,
      })
      .onConflictDoUpdate({
        target: serverRoutes.serverId,
        set: {
          proxyTarget: `${names.service}.${namespace}.svc.cluster.local`,
          port: SERVER_PORT,
          updatedAt: new Date(),
        },
      });
  });
}

//NOTE: 'type' is assumed
// serverConfigs per PR #44 (not yet merged); confirm the exact column
// name once that lands and adjust the select below if it differs.
async function getProvisionConfig(serverId: string): Promise<ProvisionConfig> {
  const [row] = await db
    .select({
      game: gameServers.game,
      type: serverConfigs.type,
      version: serverConfigs.version,
      cpuCores: serverConfigs.cpuCores,
      ramMb: serverConfigs.ramMb,
      storageGb: serverConfigs.storageGb,
      storageClass: serverConfigs.storageClass,
      gameConfigJson: serverConfigs.gameConfigJson,
    })
    .from(gameServers)
    .innerJoin(serverConfigs, eq(serverConfigs.serverId, gameServers.id))
    .where(eq(gameServers.id, serverId))
    .limit(1);

  if (!row) {
    throw new Error(`No server_configs/game_servers row found for server ${serverId}`);
  }

  const config = row as ProvisionConfig;

  if (!config.version) {
    throw new Error(`Server ${serverId} has no Minecraft version configured`);
  }

  // Loader-specific types require a loaderVersion. Previously enforced by
  // zod's superRefine on the incoming request — re-enforced here since we
  // now read this straight from the DB, with no guarantee the row went
  // through that validation.
  if (
    (config.type === "fabric" || config.type === "forge") &&
    !config.gameConfigJson.loaderVersion
  ) {
    throw new Error(
      `Server ${serverId} has type "${config.type}" but no loaderVersion set in gameConfigJson`,
    );
  }

  return config;
}

export async function provisionGameServer(serverId: string): Promise<boolean> {
  validateKubernetesNameSegment(serverId, "serverId");

  const [owner] = await db
    .select({ userId: gameServers.userId })
    .from(gameServers)
    .where(eq(gameServers.id, serverId))
    .limit(1);
  if (!owner) {
    throw new Error(`No game server row for ${serverId}`);
  }

  const namespace = await ensureTenantNamespace(owner.userId);

  const config = await getProvisionConfig(serverId);
  const allowedRuntimes = SUPPORTED_RUNTIMES[config.game];
  if (!allowedRuntimes) {
    throw new Error(`Unsupported game: ${config.game}`);
  }
  if (!allowedRuntimes.includes(config.type)) {
    throw new Error(
      `Unsupported runtime '${config.type}' for game '${config.game}'. Allowed: ${allowedRuntimes.join(", ")}`,
    );
  }

  validateKubernetesNameSegment(config.type, "type");

  const names = getServerResourceNames(serverId);
  let image: string;
  if (config.game === "minecraft") {
    image = await MinecraftUtils.getRuntimeImage(config.version);
  } else {
    throw new Error(`No image resolver implemented for game: ${config.game}`);
  }
  const labels = buildLabels(serverId, config.type);
  const resources = buildResourceSpec(config.cpuCores, config.ramMb);
  const clients = makeKubernetesClients();
  const createdResources: ProvisionedResource[] = [];

  try {
    await ensureProvisioningResourcesDoNotExist(clients, names, namespace);

    if (!TEST_EXISTING_PVC_NAME) {
      await clients.core.createNamespacedPersistentVolumeClaim({
        namespace,
        body: buildPvc(namespace, names, labels, config.storageGb, config.storageClass),
      });
      createdResources.push("pvc");
    }

    await clients.core.createNamespacedConfigMap({
      namespace,
      body: buildConfigMap(namespace, names, labels, config),
    });
    createdResources.push("configMap");

    await clients.core.createNamespacedConfigMap({
      namespace,
      body: buildPaperGlobalConfigMap(namespace, names, labels),
    });
    createdResources.push("filesConfigMap");

    await clients.apps.createNamespacedDeployment({
      namespace,
      body: buildDeployment(namespace, names, labels, image, resources),
    });
    createdResources.push("deployment");

    await clients.core.createNamespacedService({
      namespace,
      body: buildService(namespace, names, labels),
    });
    createdResources.push("service");

    await clients.networking.createNamespacedNetworkPolicy({
      namespace,
      body: buildNetworkPolicy(namespace, names, labels),
    });
    createdResources.push("networkPolicy");

    await waitForDeploymentReplicasReady(
      clients.apps,
      names.deployment,
      namespace,
      TEST_WORKLOAD_REPLICAS,
    );
    await persistProvisioningState(serverId, names, namespace);

    return true;
  } catch (error) {
    console.error(
      `[${serverId}] Provisioning failed; rolling back created Kubernetes resources`,
      error,
    );

    await rollbackProvisionedResources(clients, names, createdResources, namespace);

    await db
      .update(gameServers)
      .set({
        currentState: "failed",
        statusMessage: "Provisioning failed.",
        updatedAt: new Date(),
      })
      .where(eq(gameServers.id, serverId));

    return false;
  }
}

export async function deleteGameServer(serverId: string): Promise<boolean> {
  try {
    const k8sRecord = await db.query.serverK8s.findFirst({
      where: eq(serverK8s.serverId, serverId),
    });

    if (!k8sRecord) {
      console.warn(`[${serverId}] No Kubernetes metadata found; skipping cluster teardown`);
      return true;
    }

    const clients = makeKubernetesClients();

    const names: ServerResourceNames = {
      deployment: k8sRecord.deploymentName,
      service: k8sRecord.serviceName,
      pvc: k8sRecord.pvcName,
      configMap: `cm-server-${serverId}`,
      filesConfigMap: `cm-server-${serverId}-files`,
      networkPolicy: `netpol-server-${serverId}`,
    };

    await deleteKubernetesResources(clients, names, k8sRecord.namespace);

    return true;
  } catch (error) {
    console.error(`[${serverId}] Failed to delete game server`, error);

    return false;
  }
}
