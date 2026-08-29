import http from "node:http";
import https from "node:https";
import * as k8s from "@kubernetes/client-node";

const AWS_REGION = process.env.AWS_REGION ?? "ap-south-1";
const AWS_PROFILE = process.env.AWS_PROFILE;
const AWS_ACCOUNT_ID = process.env.FARLANDS_AWS_ACCOUNT_ID;
export const CLUSTER_NAME = "farlands-dev";
export const NAMESPACE = process.env.FARLANDS_PROXY_NAMESPACE ?? "infra-team";
const ASSUME_ROLE_ARN = process.env.FARLANDS_EKS_ASSUME_ROLE_ARN;
const USE_LOCAL_ASSUME_ROLE = process.env.FARLANDS_EKS_ASSUME_ROLE === "true";

export type KubernetesClients = {
  core: k8s.CoreV1Api;
  apps: k8s.AppsV1Api;
  networking: k8s.NetworkingV1Api;
};

export type DeploymentStatusReader = {
  readNamespacedDeployment(request: { name: string; namespace: string }): Promise<{
    status?: {
      replicas?: number;
      readyReplicas?: number;
    };
  }>;
};

class NodeHttpLibrary implements k8s.HttpLibrary {
  send(request: k8s.RequestContext): k8s.Observable<k8s.ResponseContext> {
    return new k8s.Observable(
      new Promise<k8s.ResponseContext>((resolve, reject) => {
        const requestUrl = new URL(request.getUrl());
        const transport = requestUrl.protocol === "http:" ? http : https;
        const body = request.getBody();

        const outgoing = transport.request(
          requestUrl,
          {
            method: request.getHttpMethod(),
            headers: request.getHeaders(),
            agent: request.getAgent(),
            signal: request.getSignal(),
          },
          (response) => {
            const chunks: Buffer[] = [];

            response.on("data", (chunk: Buffer | string) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });

            response.on("error", reject);

            response.on("end", () => {
              const responseBody = Buffer.concat(chunks);
              const headers = Object.fromEntries(
                Object.entries(response.headers).map(([key, value]) => [
                  key,
                  Array.isArray(value) ? value.join(", ") : `${value ?? ""}`,
                ]),
              );

              resolve(
                new k8s.ResponseContext(response.statusCode ?? 0, headers, {
                  text: async () => responseBody.toString("utf-8"),
                  binary: async () => responseBody,
                }),
              );
            });
          },
        );

        outgoing.on("error", reject);

        if (typeof body === "string" || Buffer.isBuffer(body)) {
          outgoing.write(body);
        } else if (body) {
          outgoing.write(body.toString());
        }

        outgoing.end();
      }),
    );
  }
}

export function loadFarlandsKubeConfig(): k8s.KubeConfig {
  const kubeConfig = new k8s.KubeConfig();

  if (process.env.KUBERNETES_SERVICE_HOST && process.env.KUBERNETES_SERVICE_PORT) {
    kubeConfig.loadFromCluster();
    return kubeConfig;
  }

  kubeConfig.loadFromDefault();

  const currentContext = kubeConfig.getCurrentContext();
  const context =
    kubeConfig
      .getContexts()
      .find(
        (candidate: k8s.Context) =>
          candidate.name.includes(CLUSTER_NAME) || candidate.cluster.includes(CLUSTER_NAME),
      ) ??
    kubeConfig.getContexts().find((candidate: k8s.Context) => {
      if (candidate.name !== currentContext) {
        return false;
      }

      const cluster = kubeConfig.getCluster(candidate.cluster);
      return cluster?.server.includes(`.${AWS_REGION}.eks.amazonaws.com`) ?? false;
    });

  if (!context) {
    const accountContext = AWS_ACCOUNT_ID ? ` in account ${AWS_ACCOUNT_ID}` : "";
    throw new Error(`No kubeconfig context found for EKS cluster ${CLUSTER_NAME}${accountContext}`);
  }

  kubeConfig.setCurrentContext(context.name);
  const tokenArgs = ["eks", "get-token", "--cluster-name", CLUSTER_NAME, "--region", AWS_REGION];
  if (AWS_PROFILE) {
    tokenArgs.push("--profile", AWS_PROFILE);
  }

  if (USE_LOCAL_ASSUME_ROLE) {
    if (!ASSUME_ROLE_ARN) {
      throw new Error(
        "FARLANDS_EKS_ASSUME_ROLE_ARN is required when FARLANDS_EKS_ASSUME_ROLE is true",
      );
    }

    tokenArgs.push("--role-arn", ASSUME_ROLE_ARN);
  }

  kubeConfig.users = [
    {
      name: "farlands-infra-team-contributor",
      exec: {
        apiVersion: "client.authentication.k8s.io/v1beta1",
        command: "aws",
        args: tokenArgs,
      },
    },
  ];
  (context as unknown as { user: string }).user = "farlands-infra-team-contributor";

  return kubeConfig;
}

export function makeKubernetesClients(): KubernetesClients {
  const kubeConfig = loadFarlandsKubeConfig();
  const cluster = kubeConfig.getCurrentCluster();

  if (!cluster) {
    throw new Error("No active Kubernetes cluster found in kubeconfig");
  }

  const clientConfig = k8s.createConfiguration({
    baseServer: new k8s.ServerConfiguration(cluster.server, {}),
    authMethods: {
      default: kubeConfig,
    },
    httpApi: new NodeHttpLibrary(),
  });

  return {
    core: new k8s.CoreV1Api(clientConfig),
    apps: new k8s.AppsV1Api(clientConfig),
    networking: new k8s.NetworkingV1Api(clientConfig),
  };
}

export async function waitForDeploymentReplicasReady(
  appsApi: DeploymentStatusReader,
  deploymentName: string,
  namespace: string,
  target: number,
  { timeoutMs = 180_000, intervalMs = 2_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const deployment = await appsApi.readNamespacedDeployment({
      name: deploymentName,
      namespace,
    });
    const currentReplicas =
      target === 0 ? (deployment.status?.replicas ?? 0) : (deployment.status?.readyReplicas ?? 0);

    if (currentReplicas === target) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for deployment to reach ${target} replicas`);
}

export function getKubernetesStatusCode(error: unknown): number | undefined {
  const err = error as {
    code?: number;
    httpStatusCode?: number;
    statusCode?: number;
    response?: { statusCode?: number };
  };
  return err.httpStatusCode ?? err.code ?? err.response?.statusCode ?? err.statusCode;
}
