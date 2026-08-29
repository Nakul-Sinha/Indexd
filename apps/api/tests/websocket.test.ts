import { expect, mock, test } from "bun:test";

// 1. Setup mocks before importing index.ts
const mockReadNamespacedPodLog = mock(async (_params, options) => {
  const requestContext = {
    setHeaderParam: mock(() => {}),
  };
  await options.middleware[0].pre(requestContext).toPromise();

  const responseContext = {
    headers: {},
  };
  await options.middleware[0].post(responseContext).toPromise();

  expect(requestContext.setHeaderParam).toHaveBeenCalledWith("Accept", "text/plain, */*;q=0.8");
  expect(responseContext.headers).toEqual({
    "content-type": "text/plain",
  });

  return [
    "2026-01-01T00:00:00.000000000Z Mock log line 1",
    "2026-01-01T00:00:01.000000000Z Mock log line 2",
  ].join("\n");
});

const mockCoreApi = {
  readNamespacedPodLog: mockReadNamespacedPodLog,
  readNamespacedPod: async () => ({
    metadata: { name: "mock-pod" },
    spec: { containers: [{ name: "mock-container" }] },
  }),
  listNamespacedPod: async () => ({
    items: [
      {
        metadata: { name: "mock-pod", creationTimestamp: new Date() },
        status: { phase: "Running" },
        spec: { containers: [{ name: "mock-container" }] },
      },
    ],
  }),
};

const mockAppsApi = {
  readNamespacedDeployment: async (_request?: {
    name: string;
    namespace: string;
  }): Promise<{
    status?: { replicas?: number; readyReplicas?: number };
  }> => ({}),
};

mock.module("@kubernetes/client-node", () => {
  return {
    KubeConfig: class {
      loadFromDefault() {}
      makeApiClient() {
        return mockCoreApi;
      }
    },
    Observable: class<T> {
      constructor(private readonly promise: Promise<T>) {}
      toPromise() {
        return this.promise;
      }
    },
    CoreV1Api: class {},
  };
});

mock.module("../src/modules/provisioning/kubernetes", () => {
  return {
    CLUSTER_NAME: "farlands-dev",
    NAMESPACE: "infra-team",
    getKubernetesStatusCode: (error: any) =>
      error?.code ?? error?.response?.statusCode ?? error?.statusCode,
    waitForDeploymentReplicasReady: async (
      appsApi: typeof mockAppsApi,
      deploymentName: string,
      namespace: string,
      target: number,
      { timeoutMs = 180_000, intervalMs = 2_000 } = {},
    ) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const deployment = await appsApi.readNamespacedDeployment({
          name: deploymentName,
          namespace,
        });
        const currentReplicas =
          target === 0
            ? (deployment.status?.replicas ?? 0)
            : (deployment.status?.readyReplicas ?? 0);
        if (currentReplicas === target) return;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      throw new Error(`Timed out waiting for deployment to reach ${target} replicas`);
    },
    makeKubernetesClients: () => ({
      core: mockCoreApi,
      apps: mockAppsApi,
      networking: {},
    }),
  };
});

mock.module("../src/db", () => {
  return {
    db: {
      query: {
        sessions: {
          // The session token value matches what parseCookie extracts from the
          // Cookie header sent by the test WebSocket client below.
          findFirst: async () => ({
            userId: "mock-user-id",
            expiresAt: new Date(Date.now() + 1000 * 3600), // valid for 1 hour
          }),
        },
        gameServers: {
          findFirst: async () => ({
            id: "test-server",
            userId: "mock-user-id",
          }),
        },
        serverK8s: {
          findFirst: async () => ({
            namespace: "mock-ns",
            deploymentName: "mock-deployment",
            podName: "mock-pod",
          }),
        },
      },
    },
  };
});

// Port zero lets the OS allocate an unused test port without colliding with development.
process.env.PORT = "0";
const { app } = require("../src/index");
const testPort = app.server?.port;

test.skip("WebSocket streams logs and closes cleanly", () => {
  return new Promise<void>((resolve, reject) => {
    // Pass the session token as an httpOnly-style Cookie header on the upgrade
    // request rather than embedding it in the URL query string (fix for the
    // URL-token security issue flagged by Greptile).
    const ws = new WebSocket(`ws://localhost:${testPort}/api/servers/test-server/logs`, {
      headers: {
        Cookie: "session_token=test-token",
      },
    } as any);

    const receivedLogs: string[] = [];

    ws.onopen = () => {
      console.log("Test client WebSocket opened.");
    };

    ws.onmessage = (event) => {
      const msg = event.data;
      console.log("Test client received log:", msg);
      receivedLogs.push(msg);

      if (receivedLogs.length === 2) {
        try {
          expect(receivedLogs[0]).toContain("Mock log line 1");
          expect(receivedLogs[1]).toContain("Mock log line 2");
          ws.close();
        } catch (err) {
          ws.close();
          reject(err);
        }
      }
    };

    ws.onclose = () => {
      console.log("Test client WebSocket closed. Verifying log read...");
      // Allow the backend close() handler to run before asserting.
      setTimeout(async () => {
        try {
          expect(mockReadNamespacedPodLog).toHaveBeenCalled();
          console.log("Cleanup verification successful! Logs were read.");
          await app.stop();
          resolve();
        } catch (err) {
          await app.stop();
          reject(err);
        }
      }, 100);
    };

    ws.onerror = async (err) => {
      console.error("Test WebSocket error:", err);
      await app.stop();
      reject(err);
    };
  });
});
