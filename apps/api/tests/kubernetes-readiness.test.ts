import { expect, test } from "bun:test";

import {
  type DeploymentStatusReader,
  waitForDeploymentReplicasReady,
} from "../src/modules/provisioning/kubernetes";

function makeStatusReader(
  statuses: Array<{ replicas?: number; readyReplicas?: number }>,
): DeploymentStatusReader & { calls: number } {
  return {
    calls: 0,
    async readNamespacedDeployment() {
      const status = statuses[Math.min(this.calls, statuses.length - 1)];
      this.calls += 1;
      return { status };
    },
  };
}

test("waits for a deployment's target number of ready replicas", async () => {
  const appsApi = makeStatusReader([
    { replicas: 1, readyReplicas: 0 },
    { replicas: 1, readyReplicas: 1 },
  ]);

  await waitForDeploymentReplicasReady(appsApi, "deploy-server-test", "infra-team", 1, {
    timeoutMs: 1_000,
    intervalMs: 0,
  });

  expect(appsApi.calls).toBe(2);
});

test("waits for all replicas to disappear when scaling down", async () => {
  const appsApi = makeStatusReader([
    { replicas: 1, readyReplicas: 0 },
    { replicas: 0, readyReplicas: 0 },
  ]);

  await waitForDeploymentReplicasReady(appsApi, "deploy-server-test", "infra-team", 0, {
    timeoutMs: 1_000,
    intervalMs: 0,
  });

  expect(appsApi.calls).toBe(2);
});
