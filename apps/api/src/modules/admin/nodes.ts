import { gameServers, serverConfigs, serverK8s, users } from "@repo/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { status } from "elysia";

import { db } from "../../db";
import { makeKubernetesClients, NAMESPACE } from "../provisioning/kubernetes";

const SERVER_ID_LABEL = "farlands.dev/server-id";

function getRoles(labels: Record<string, string> | undefined): string[] {
  const roles = Object.keys(labels ?? {})
    .filter((key) => key.startsWith("node-role.kubernetes.io/"))
    .map((key) => key.slice("node-role.kubernetes.io/".length))
    .filter(Boolean);
  return roles;
}

function getStatus(conditions: Array<{ type: string; status: string }> = []) {
  const ready = conditions.find((condition) => condition.type === "Ready");
  if (ready?.status === "True") return "ready" as const;
  if (ready?.status === "False") return "not-ready" as const;
  return "unknown" as const;
}

export abstract class AdminNodesService {
  private static readonly serverSelection = {
    id: gameServers.id,
    name: gameServers.name,
    ownerEmail: users.email,
    game: gameServers.game,
    currentState: gameServers.currentState,
    desiredState: gameServers.desiredState,
    statusMessage: gameServers.statusMessage,
    version: serverConfigs.version,
    cpuCores: serverConfigs.cpuCores,
    ramMb: serverConfigs.ramMb,
    deploymentName: serverK8s.deploymentName,
    namespace: serverK8s.namespace,
    createdAt: gameServers.createdAt,
    updatedAt: gameServers.updatedAt,
  };

  static async list() {
    let nodes;
    let pods;
    try {
      const { core } = makeKubernetesClients();
      [nodes, pods] = await Promise.all([
        core.listNode(),
        core.listNamespacedPod({ namespace: NAMESPACE }),
      ]);
    } catch (error) {
      console.error("Admin node inventory could not reach Kubernetes", error);
      throw status(503, "Cluster inventory is temporarily unavailable");
    }

    const podsByNode = new Map<string, typeof pods.items>();
    for (const pod of pods.items) {
      const nodeName = pod.spec?.nodeName;
      if (!nodeName) continue;
      const scheduledPods = podsByNode.get(nodeName) ?? [];
      scheduledPods.push(pod);
      podsByNode.set(nodeName, scheduledPods);
    }

    return nodes.items.map((node) => {
      const name = node.metadata?.name ?? "unknown";
      const scheduledPods = podsByNode.get(name) ?? [];
      const serverIds = new Set(
        scheduledPods
          .map((pod) => pod.metadata?.labels?.[SERVER_ID_LABEL])
          .filter((id): id is string => Boolean(id)),
      );

      return {
        id: node.metadata?.uid ?? name,
        name,
        status: getStatus(node.status?.conditions),
        roles: getRoles(node.metadata?.labels),
        kubernetesVersion: node.status?.nodeInfo?.kubeletVersion ?? "unknown",
        capacity: node.status?.capacity ?? {},
        allocatable: node.status?.allocatable ?? {},
        createdAt: node.metadata?.creationTimestamp ?? null,
        schedulingDisabled: Boolean(node.spec?.unschedulable),
        scheduling: {
          pods: scheduledPods.length,
          gameServers: serverIds.size,
          capacityPods: node.status?.capacity?.pods ?? "0",
          allocatablePods: node.status?.allocatable?.pods ?? "0",
        },
      };
    });
  }

  static async get(nodeName: string) {
    const nodes = await this.list();
    const node = nodes.find((candidate) => candidate.name === nodeName);
    if (!node) throw status(404, "Node not found");

    let pods;
    try {
      const { core } = makeKubernetesClients();
      pods = await core.listNamespacedPod({ namespace: NAMESPACE });
    } catch (error) {
      console.error(`Admin node detail failed for ${nodeName}`, error);
      throw status(503, "Cluster inventory is temporarily unavailable");
    }
    const serverIds = [
      ...new Set(
        pods.items
          .filter((pod) => pod.spec?.nodeName === nodeName)
          .map((pod) => pod.metadata?.labels?.[SERVER_ID_LABEL])
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    if (serverIds.length === 0) return { ...node, gameServers: [] };

    const servers = await db
      .select(this.serverSelection)
      .from(gameServers)
      .innerJoin(users, eq(users.id, gameServers.userId))
      .leftJoin(serverConfigs, eq(serverConfigs.serverId, gameServers.id))
      .innerJoin(serverK8s, eq(serverK8s.serverId, gameServers.id))
      .where(and(inArray(gameServers.id, serverIds), ne(gameServers.currentState, "deleted")));

    return { ...node, gameServers: servers };
  }

  static async listGameServers() {
    let pods;
    try {
      const { core } = makeKubernetesClients();
      pods = await core.listNamespacedPod({ namespace: NAMESPACE });
    } catch (error) {
      console.error("Admin server scheduling lookup failed", error);
      throw status(503, "Cluster inventory is temporarily unavailable");
    }
    const nodeByServerId = new Map<string, string>();
    for (const pod of pods.items) {
      const serverId = pod.metadata?.labels?.[SERVER_ID_LABEL];
      const nodeName = pod.spec?.nodeName;
      if (serverId && nodeName) nodeByServerId.set(serverId, nodeName);
    }

    const servers = await db
      .select(this.serverSelection)
      .from(gameServers)
      .innerJoin(users, eq(users.id, gameServers.userId))
      .leftJoin(serverConfigs, eq(serverConfigs.serverId, gameServers.id))
      .innerJoin(serverK8s, eq(serverK8s.serverId, gameServers.id))
      .where(ne(gameServers.currentState, "deleted"));

    return servers.map((server) => ({
      ...server,
      nodeName: nodeByServerId.get(server.id) ?? null,
    }));
  }
}
