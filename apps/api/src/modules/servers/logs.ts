import * as k8s from "@kubernetes/client-node";
import { getKubernetesStatusCode, makeKubernetesClients } from "../provisioning/kubernetes";

export type ServerLogK8sRecord = {
  namespace: string | null;
  podName: string | null;
  deploymentName: string | null;
};

export type ResolvedLogPod = {
  podName: string;
  containerName: string;
};

export type LogStreamHandle = {
  abort: () => void;
};

export type LogKubernetesClients = {
  core: k8s.CoreV1Api;
  apps: k8s.AppsV1Api;
};

type PodLogReadOptions = {
  coreApi: k8s.CoreV1Api;
  namespace: string;
  podName: string;
  containerName: string;
  tailLines: number;
  sinceSeconds?: number;
};

type PodLogTextReader = (options: PodLogReadOptions) => Promise<string>;

export type LogPodResolutionErrorCode =
  | "missing-metadata"
  | "pod-not-ready"
  | "deployment-missing"
  | "container-missing";

export class LogPodResolutionError extends Error {
  constructor(
    public readonly code: LogPodResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LogPodResolutionError";
  }
}

export function createLogKubernetesClients(): LogKubernetesClients {
  const clients = makeKubernetesClients();
  return {
    core: clients.core,
    apps: clients.apps,
  };
}

function getPrimaryContainerName(pod: k8s.V1Pod): string {
  return pod.spec?.containers[0]?.name ?? "";
}

function chooseBestPod(pods: k8s.V1Pod[]): k8s.V1Pod | null {
  if (pods.length === 0) return null;

  return (
    [...pods].sort((left, right) => {
      const runningDelta =
        (right.status?.phase === "Running" ? 1 : 0) - (left.status?.phase === "Running" ? 1 : 0);

      if (runningDelta !== 0) return runningDelta;

      const rightCreated =
        right.metadata?.creationTimestamp?.getTime?.() ??
        new Date(right.metadata?.creationTimestamp ?? 0).getTime();
      const leftCreated =
        left.metadata?.creationTimestamp?.getTime?.() ??
        new Date(left.metadata?.creationTimestamp ?? 0).getTime();

      return rightCreated - leftCreated;
    })[0] ?? null
  );
}

async function readStoredPod(
  coreApi: k8s.CoreV1Api,
  namespace: string,
  podName: string,
): Promise<k8s.V1Pod | null> {
  try {
    return await coreApi.readNamespacedPod({ name: podName, namespace });
  } catch (error) {
    if (getKubernetesStatusCode(error) === 404) {
      return null;
    }

    throw error;
  }
}

async function assertDeploymentExists(
  appsApi: k8s.AppsV1Api,
  namespace: string,
  deploymentName: string,
): Promise<void> {
  try {
    await appsApi.readNamespacedDeployment({ name: deploymentName, namespace });
  } catch (error) {
    if (getKubernetesStatusCode(error) === 404) {
      throw new LogPodResolutionError(
        "deployment-missing",
        "Kubernetes deployment is missing for this server.",
      );
    }

    throw error;
  }
}

export async function resolveServerLogPod(
  coreApi: k8s.CoreV1Api,
  appsApi: k8s.AppsV1Api,
  serverId: string,
  k8sRecord: ServerLogK8sRecord | null | undefined,
): Promise<ResolvedLogPod> {
  if (
    !k8sRecord?.namespace ||
    !k8sRecord.deploymentName ||
    k8sRecord.deploymentName.trim().length === 0
  ) {
    throw new LogPodResolutionError(
      "missing-metadata",
      "Kubernetes metadata was not found for this server.",
    );
  }

  const { namespace, deploymentName } = k8sRecord;
  let selectedPod: k8s.V1Pod | null = null;

  if (k8sRecord.podName) {
    selectedPod = await readStoredPod(coreApi, namespace, k8sRecord.podName);
  }

  if (!selectedPod) {
    const podList = await coreApi.listNamespacedPod({
      namespace,
      labelSelector: `farlands.dev/server-id=${serverId}`,
    });
    selectedPod = chooseBestPod(podList.items ?? []);
  }

  if (!selectedPod?.metadata?.name) {
    await assertDeploymentExists(appsApi, namespace, deploymentName);
    throw new LogPodResolutionError("pod-not-ready", "Server pod is not ready yet.");
  }

  const containerName = getPrimaryContainerName(selectedPod);
  if (!containerName) {
    throw new LogPodResolutionError(
      "container-missing",
      "No containers were found in the server pod.",
    );
  }

  return {
    podName: selectedPod.metadata.name,
    containerName,
  };
}

function splitLogLines(logText: string): string[] {
  return logText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function stripKubernetesTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s/, "");
}

async function readPodLogText({
  coreApi,
  namespace,
  podName,
  containerName,
  tailLines,
  sinceSeconds,
}: PodLogReadOptions): Promise<string> {
  return coreApi.readNamespacedPodLog(
    {
      name: podName,
      namespace,
      container: containerName,
      follow: false,
      previous: false,
      sinceSeconds,
      tailLines,
      timestamps: true,
    },
    {
      middleware: [
        {
          pre: (context) => {
            context.setHeaderParam("Accept", "text/plain, */*;q=0.8");
            return new k8s.Observable(Promise.resolve(context));
          },
          post: (response) => {
            response.headers["content-type"] ??= "text/plain";
            return new k8s.Observable(Promise.resolve(response));
          },
        },
      ],
      middlewareMergeStrategy: "append",
    },
  );
}

export async function startPodLogPolling(
  coreApi: k8s.CoreV1Api,
  params: {
    namespace: string;
    podName: string;
    containerName: string;
    tailLines?: number;
    intervalMs?: number;
    readLogText?: PodLogTextReader;
  },
  onChunk: (chunk: string) => void,
): Promise<LogStreamHandle> {
  const seenLines = new Set<string>();
  let stopped = false;
  let polling = false;
  const intervalMs = params.intervalMs ?? 2_000;
  const readLogText = params.readLogText ?? readPodLogText;

  const readLogs = async (tailLines: number, sinceSeconds?: number) => {
    const logText = await readLogText({
      coreApi,
      namespace: params.namespace,
      podName: params.podName,
      containerName: params.containerName,
      tailLines,
      sinceSeconds,
    });

    for (const line of splitLogLines(logText)) {
      if (seenLines.has(line)) continue;
      seenLines.add(line);
      onChunk(`${stripKubernetesTimestamp(line)}\n`);
    }

    if (seenLines.size > 2_000) {
      const recentLines = [...seenLines].slice(-1_000);
      seenLines.clear();
      for (const line of recentLines) {
        seenLines.add(line);
      }
    }
  };

  await readLogs(params.tailLines ?? 100);

  const timer = setInterval(() => {
    if (stopped || polling) return;
    polling = true;
    readLogs(100, Math.max(2, Math.ceil(intervalMs / 1000) + 1))
      .catch((error) => {
        console.error(`[${params.podName}] Failed to poll Kubernetes logs:`, error);
      })
      .finally(() => {
        polling = false;
      });
  }, intervalMs);

  return {
    abort: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
