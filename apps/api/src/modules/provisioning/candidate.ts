import { gameServers, serverConfigs, serverK8s } from "@repo/db/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  getKubernetesStatusCode,
  makeKubernetesClients,
  waitForDeploymentReplicasReady,
} from "./kubernetes";
import { ensureTenantNamespace, WORLD_SYNC_PORT } from "./tenancy";
import { calculateContainerMemory, MinecraftUtils } from "./utils";

const SERVER_PORT = 25565;

function candidateNames(liveServerId: string, deploymentId: string) {
  const short = deploymentId
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 10)
    .toLowerCase();
  return {
    deployment: `deploy-cand-${liveServerId}-${short}`,
    service: `svc-cand-${liveServerId}-${short}`,
    pvc: `pvc-cand-${liveServerId}-${short}`,
    configMap: `cm-cand-${liveServerId}-${short}`,
    filesConfigMap: `cm-cand-${liveServerId}-${short}-files`,
    networkPolicy: `netpol-cand-${liveServerId}-${short}`,
  };
}

export type CandidateResources = {
  namespace: string;
  deploymentName: string;
  serviceName: string;
  pvcName: string;
  liveDeploymentName: string;
  liveServiceName: string;
};

export async function provisionCandidate(input: {
  liveServerId: string;
  deploymentId: string;
  jarUrl: string;
}): Promise<CandidateResources> {
  const [server] = await db
    .select()
    .from(gameServers)
    .where(eq(gameServers.id, input.liveServerId))
    .limit(1);
  if (!server) throw new Error(`Server ${input.liveServerId} not found`);

  const k8sRow = await db.query.serverK8s.findFirst({
    where: eq(serverK8s.serverId, input.liveServerId),
  });
  if (!k8sRow) throw new Error(`Server ${input.liveServerId} has no k8s record`);

  const [config] = await db
    .select()
    .from(serverConfigs)
    .where(eq(serverConfigs.serverId, input.liveServerId))
    .limit(1);
  if (!config) throw new Error(`Server ${input.liveServerId} has no config`);

  const namespace = await ensureTenantNamespace(server.userId);
  const names = candidateNames(input.liveServerId, input.deploymentId);
  const clients = makeKubernetesClients();
  const image = await MinecraftUtils.getRuntimeImage(config.version ?? "latest");
  const mem = calculateContainerMemory(config.ramMb);
  const labels = {
    "app.kubernetes.io/name": "farlands-candidate",
    "app.kubernetes.io/managed-by": "farlands-backend",
    "farlands.dev/server-id": `${input.liveServerId}-cand`,
    "farlands.dev/live-server-id": input.liveServerId,
    "farlands.dev/deployment-id": input.deploymentId,
    "farlands.dev/role": "candidate",
  };

  await clients.core.createNamespacedPersistentVolumeClaim({
    namespace,
    body: {
      metadata: { name: names.pvc, namespace, labels },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: config.storageClass,
        resources: { requests: { storage: `${config.storageGb}Gi` } },
      },
    },
  });

  await clients.core.createNamespacedConfigMap({
    namespace,
    body: {
      metadata: { name: names.configMap, namespace, labels },
      data: {
        EULA: "true",
        ENABLE_RCON: "true",
        RCON_PASSWORD_FILE: "/run/secrets/rcon/password",
        ONLINE_MODE: "false",
        SERVER_PORT: String(SERVER_PORT),
        TYPE: config.type.toUpperCase(),
        VERSION: config.version ?? "latest",
        REPLACE_ENV_DURING_SYNC: "true",
      },
    },
  });

  await clients.apps.createNamespacedDeployment({
    namespace,
    body: {
      metadata: { name: names.deployment, namespace, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: { "farlands.dev/deployment-id": input.deploymentId } },
        template: {
          metadata: { labels },
          spec: {
            tolerations: [
              {
                key: "farlands.sh/nodepool",
                operator: "Equal",
                value: "infra-team-autoscale",
                effect: "NoSchedule",
              },
            ],
            initContainers: [
              {
                name: "world-receiver",
                image: "python:3.12-alpine",
                command: [
                  "sh",
                  "-c",
                  "apk add --no-cache tar >/dev/null && python3 /sync/receiver.py",
                ],
                env: [
                  { name: "WORLD_SYNC_PORT", value: String(WORLD_SYNC_PORT) },
                  { name: "WORLD_ROOT", value: "/data/world" },
                ],
                volumeMounts: [
                  { name: "server-data", mountPath: "/data" },
                  { name: "world-sync", mountPath: "/sync" },
                ],
              },
            ],
            containers: [
              {
                name: "game-server",
                image,
                imagePullPolicy: "IfNotPresent",
                // Paper is deliberately NOT started. World lands via the
                // receiver init; the controller starts Paper in verifying.
                command: ["sh", "-c", "echo 'candidate held; Paper not started'; sleep infinity"],
                envFrom: [{ configMapRef: { name: names.configMap } }],
                resources: {
                  requests: { cpu: config.cpuCores, memory: `${mem}Mi` },
                  limits: { cpu: config.cpuCores, memory: `${mem}Mi` },
                },
                volumeMounts: [
                  { name: "server-data", mountPath: "/data" },
                  {
                    name: "rcon",
                    mountPath: "/run/secrets/rcon",
                    readOnly: true,
                  },
                ],
              },
            ],
            volumes: [
              {
                name: "server-data",
                persistentVolumeClaim: { claimName: names.pvc },
              },
              { name: "world-sync", configMap: { name: "cm-world-sync" } },
              {
                name: "rcon",
                secret: { secretName: "rcon-password" },
              },
            ],
          },
        },
      },
    },
  });

  await clients.core.createNamespacedService({
    namespace,
    body: {
      metadata: { name: names.service, namespace, labels },
      spec: {
        type: "ClusterIP",
        selector: { "farlands.dev/deployment-id": input.deploymentId },
        ports: [
          { name: "minecraft", port: SERVER_PORT, targetPort: SERVER_PORT },
          { name: "world-sync", port: WORLD_SYNC_PORT, targetPort: WORLD_SYNC_PORT },
        ],
      },
    },
  });

  await waitForDeploymentReplicasReady(clients.apps, names.deployment, namespace, 1, {
    timeoutMs: 240_000,
  });

  return {
    namespace,
    deploymentName: names.deployment,
    serviceName: names.service,
    pvcName: names.pvc,
    liveDeploymentName: k8sRow.deploymentName,
    liveServiceName: k8sRow.serviceName,
  };
}

export async function deleteCandidate(input: {
  namespace: string;
  deploymentName: string;
  liveServerId: string;
  deploymentId: string;
}): Promise<void> {
  const names = candidateNames(input.liveServerId, input.deploymentId);
  const clients = makeKubernetesClients();
  const ns = input.namespace;

  const deletions: Array<() => Promise<unknown>> = [
    () =>
      clients.apps.deleteNamespacedDeployment({
        name: names.deployment,
        namespace: ns,
      }),
    () =>
      clients.core.deleteNamespacedService({
        name: names.service,
        namespace: ns,
      }),
    () =>
      clients.core.deleteNamespacedConfigMap({
        name: names.configMap,
        namespace: ns,
      }),
    () =>
      clients.core.deleteNamespacedPersistentVolumeClaim({
        name: names.pvc,
        namespace: ns,
      }),
  ];

  for (const del of deletions) {
    try {
      await del();
    } catch (error) {
      if (getKubernetesStatusCode(error) !== 404) throw error;
    }
  }
}

export async function startPaperOnCandidate(
  namespace: string,
  deploymentName: string,
): Promise<void> {
  const clients = makeKubernetesClients();
  const deploy = await clients.apps.readNamespacedDeployment({
    name: deploymentName,
    namespace,
  });
  const container = deploy.spec?.template?.spec?.containers?.[0];
  if (!container) throw new Error("candidate container missing");
  delete container.command;
  delete container.args;
  await clients.apps.replaceNamespacedDeployment({
    name: deploymentName,
    namespace,
    body: deploy,
  });
}
