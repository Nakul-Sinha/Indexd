import { describe, expect, test } from "bun:test";

import { buildBackupDeleteJob, buildBackupRestoreJob } from "../src/modules/backup/k8s-job";

const storageConfig = {
  bucket: "backup-bucket",
  region: "ap-south-1",
  prefix: "infra-team",
};

describe("backup restore Kubernetes job", () => {
  test("downloads the archive before replacing the stopped server PVC", () => {
    const job = buildBackupRestoreJob(
      "restore-backup-id-timestamp",
      "backup-id",
      "server-id",
      "pvc-server-id",
      "infra-team/server-id/archive.tar.gz",
      storageConfig,
    );

    const podSpec = job.spec?.template.spec!;

    expect(job.metadata?.labels?.["farlands.dev/backup-operation"]).toBe("restore");
    expect(podSpec.initContainers?.[0]?.name).toBe("download-backup");
    expect(podSpec.containers[0]?.name).toBe("restore-backup");
    expect(podSpec.volumes?.[0]?.persistentVolumeClaim?.claimName).toBe("pvc-server-id");
    expect(podSpec.affinity).toBeUndefined();

    const restoreCommand = podSpec.containers[0]?.command?.[2];
    expect(restoreCommand).toContain("find /world -mindepth 1");
    expect(restoreCommand).toContain("tar -xzf /backup/restore.tar.gz");

    const storagePath = podSpec.initContainers?.[0]?.env?.find(
      (entry: { name: string }) => entry.name === "STORAGE_PATH",
    );
    expect(storagePath?.value).toBe("infra-team/server-id/archive.tar.gz");
  });
});

describe("backup delete Kubernetes job", () => {
  test("passes the storage key through an environment variable", () => {
    const job = buildBackupDeleteJob(
      "delete-backup-id-timestamp",
      "backup-id",
      "server-id",
      "infra-team/server-id/archive.tar.gz",
      storageConfig,
    );
    const container = job.spec?.template.spec?.containers[0];

    expect(container?.command?.[2]).toContain("${STORAGE_PATH}");
    expect(container?.command?.[2]).not.toContain("infra-team/server-id/archive.tar.gz");
    expect(container?.env?.find((entry) => entry.name === "STORAGE_PATH")?.value).toBe(
      "infra-team/server-id/archive.tar.gz",
    );
  });
});
