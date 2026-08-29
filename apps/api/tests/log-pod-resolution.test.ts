import { expect, test } from "bun:test";
import type * as k8s from "@kubernetes/client-node";
import { type LogPodResolutionError, resolveServerLogPod } from "../src/modules/servers/logs";

function notFoundError() {
  return { response: { statusCode: 404 } };
}

function pod(
  name: string,
  phase: string,
  createdAt: string,
  containerName = "game-server",
): k8s.V1Pod {
  return {
    metadata: {
      name,
      creationTimestamp: new Date(createdAt),
    },
    status: { phase },
    spec: { containers: [{ name: containerName }] },
  } as k8s.V1Pod;
}

test("resolves pod by server label when stored podName is null", async () => {
  const calls: unknown[] = [];
  const coreApi = {
    listNamespacedPod: async (params: unknown) => {
      calls.push(params);
      return {
        items: [
          pod("pending-pod", "Pending", "2026-01-01T00:00:00.000Z"),
          pod("running-pod", "Running", "2026-01-01T00:00:01.000Z"),
        ],
      };
    },
  } as unknown as k8s.CoreV1Api;
  const appsApi = {} as unknown as k8s.AppsV1Api;

  const result = await resolveServerLogPod(coreApi, appsApi, "server-123", {
    namespace: "infra-team",
    deploymentName: "deploy-server-123",
    podName: null,
  });

  expect(result).toEqual({
    podName: "running-pod",
    containerName: "game-server",
  });
  expect(calls).toEqual([
    {
      namespace: "infra-team",
      labelSelector: "farlands.dev/server-id=server-123",
    },
  ]);
});

test("reports pod not ready when no pod exists but deployment exists", async () => {
  const coreApi = {
    listNamespacedPod: async () => ({ items: [] }),
  } as unknown as k8s.CoreV1Api;
  const appsApi = {
    readNamespacedDeployment: async () => ({}),
  } as unknown as k8s.AppsV1Api;

  await expect(
    resolveServerLogPod(coreApi, appsApi, "server-123", {
      namespace: "infra-team",
      deploymentName: "deploy-server-123",
      podName: null,
    }),
  ).rejects.toMatchObject({
    code: "pod-not-ready",
  } satisfies Partial<LogPodResolutionError>);
});

test("reports missing deployment when no pod or deployment exists", async () => {
  const coreApi = {
    listNamespacedPod: async () => ({ items: [] }),
  } as unknown as k8s.CoreV1Api;
  const appsApi = {
    readNamespacedDeployment: async () => {
      throw notFoundError();
    },
  } as unknown as k8s.AppsV1Api;

  await expect(
    resolveServerLogPod(coreApi, appsApi, "server-123", {
      namespace: "infra-team",
      deploymentName: "deploy-server-123",
      podName: null,
    }),
  ).rejects.toMatchObject({
    code: "deployment-missing",
  } satisfies Partial<LogPodResolutionError>);
});

test("reports missing metadata before querying Kubernetes", async () => {
  const coreApi = {
    listNamespacedPod: async () => {
      throw new Error("should not query pods");
    },
  } as unknown as k8s.CoreV1Api;
  const appsApi = {
    readNamespacedDeployment: async () => {
      throw new Error("should not query deployments");
    },
  } as unknown as k8s.AppsV1Api;

  await expect(resolveServerLogPod(coreApi, appsApi, "server-123", null)).rejects.toMatchObject({
    code: "missing-metadata",
  } satisfies Partial<LogPodResolutionError>);
});
