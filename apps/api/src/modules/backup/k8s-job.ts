import type * as k8s from "@kubernetes/client-node";
import { makeKubernetesClients } from "../../lib/k8s";
import { type BackupStorageConfig, resolveBackupStorageConfig } from "./config";

// ── env vars ──────────────────────────────────────────────────────────────────
// Runtime/image settings have safe defaults matching the cronjob Terraform.
// Bucket, region, and prefix resolution is centralized in config.ts.

const NAMESPACE = process.env.BACKUP_NAMESPACE ?? "infra-team";
const ARCHIVE_IMAGE = process.env.BACKUP_IMAGE_ARCHIVE ?? "alpine:3.20";
const UPLOAD_IMAGE = process.env.BACKUP_IMAGE_UPLOAD ?? "amazon/aws-cli:2.15.0";
const SERVICE_ACCOUNT = process.env.BACKUP_SERVICE_ACCOUNT ?? "backup-orchestrator";

export type BackupJobState =
  | { status: "pending" }
  | { status: "completed"; jobName: string; operation: string }
  | { status: "failed"; jobName: string; operation: string };

// ── helpers ───────────────────────────────────────────────────────────────────

function sanitizeJobName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

function isoTimestamp(): string {
  // Produces e.g. "20260718T154500Z" — same format as the cronjob orchestrator.
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Dispatches a Kubernetes Job that archives the server's PVC and uploads it to
 * S3. The job uses the same two-container pattern as the cronjob orchestrator:
 *   1. init-container (alpine + tar): creates the archive
 *   2. main container (aws-cli):      uploads it to S3
 *
 * Returns the K8s job name so it can be stored for later correlation.
 *
 * @param backupId    - The DB backup record ID (used as a label for tracing)
 * @param serverId    - The game server ID (used for labels and S3 key)
 * @param pvcName     - The PVC to archive (looked up from serverK8s)
 * @param storagePath - The full S3 key (e.g. "infra-team/<serverId>/<file>.tar.gz")
 *                      Caller computes this so the DB record and the job agree.
 */
export async function dispatchBackupJob(
  backupId: string,
  serverId: string,
  pvcName: string,
  storagePath: string,
): Promise<string> {
  const storageConfig = resolveBackupStorageConfig();
  const ts = isoTimestamp();
  const archiveFile = storagePath.split("/").pop()!;
  const jobName = sanitizeJobName(`backup-${serverId}-${ts}`);

  const { batch } = makeKubernetesClients();

  const jobSpec: k8s.V1Job = {
    metadata: {
      name: jobName,
      namespace: NAMESPACE,
      labels: {
        app: "server-backup-worker",
        "farlands.dev/server-id": serverId,
        "farlands.dev/backup-id": backupId,
        "farlands.dev/backup-operation": "create",
      },
    },
    spec: {
      // Auto-delete the job 1 hour after it finishes (matches cronjob setting).
      ttlSecondsAfterFinished: 3600,
      backoffLimit: 2,
      template: {
        metadata: {
          labels: {
            app: "server-backup-worker",
            "farlands.dev/server-id": serverId,
            "farlands.dev/backup-id": backupId,
            "farlands.dev/backup-operation": "create",
          },
        },
        spec: {
          serviceAccountName: SERVICE_ACCOUNT,
          restartPolicy: "OnFailure",

          // The game-server nodes carry a NoSchedule taint. Without this
          // toleration the scheduler cannot place the backup pod there.
          tolerations: [
            {
              key: "farlands.sh/nodepool",
              operator: "Equal",
              value: "infra-team-autoscale",
              effect: "NoSchedule",
            },
          ],

          // REQUIRED: force the backup job to run on the exact same node as the
          // server pod. The PVC is an EBS volume attached to that node — if the
          // job lands elsewhere the volume mount will fail.
          affinity: {
            podAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: [
                {
                  labelSelector: {
                    matchExpressions: [
                      {
                        key: "farlands.dev/server-id",
                        operator: "In",
                        values: [serverId],
                      },
                    ],
                  },
                  topologyKey: "kubernetes.io/hostname",
                },
              ],
            },
          },

          initContainers: [
            {
              name: "create-backup",
              image: ARCHIVE_IMAGE,
              command: [
                "/bin/sh",
                "-c",
                'apk add --no-cache tar && tar -czf "/backup/${ARCHIVE_FILE}" -C /world .',
              ],
              env: [{ name: "ARCHIVE_FILE", value: archiveFile }],
              volumeMounts: [
                { name: "server-data", mountPath: "/world", readOnly: true },
                { name: "backup-temp", mountPath: "/backup" },
              ],
            },
          ],
          containers: [
            {
              name: "upload-backup",
              image: UPLOAD_IMAGE,
              command: [
                "/bin/sh",
                "-c",
                'aws s3 cp "/backup/${ARCHIVE_FILE}" "s3://${BACKUP_BUCKET}/${STORAGE_PATH}" --region "${AWS_REGION}"',
              ],
              env: [
                { name: "ARCHIVE_FILE", value: archiveFile },
                { name: "BACKUP_BUCKET", value: storageConfig.bucket },
                { name: "STORAGE_PATH", value: storagePath },
                { name: "AWS_REGION", value: storageConfig.region },
              ],
              volumeMounts: [{ name: "backup-temp", mountPath: "/backup" }],
            },
          ],
          volumes: [
            {
              name: "server-data",
              persistentVolumeClaim: { claimName: pvcName },
            },
            { name: "backup-temp", emptyDir: {} },
          ],
        },
      },
    },
  };

  await batch.createNamespacedJob({ namespace: NAMESPACE, body: jobSpec });

  console.info(
    `[backup] Dispatched K8s job '${jobName}' for server '${serverId}' -> s3://${storageConfig.bucket}/${storagePath}`,
  );

  return jobName;
}

/**
 * Dispatches the S3 deletion step using the same in-cluster identity as
 * backup creation. The API's local credentials do not have bucket access, so
 * deleting from the backend process itself would leave the archive behind.
 */
export async function dispatchBackupDeleteJob(
  backupId: string,
  serverId: string,
  storagePath: string,
): Promise<string> {
  const storageConfig = resolveBackupStorageConfig();
  const ts = isoTimestamp();
  const jobName = sanitizeJobName(`delete-${backupId}-${ts}`);
  const { batch } = makeKubernetesClients();
  const jobSpec = buildBackupDeleteJob(jobName, backupId, serverId, storagePath, storageConfig);

  await batch.createNamespacedJob({ namespace: NAMESPACE, body: jobSpec });

  console.info(
    `[backup] Dispatched delete job '${jobName}' for backup '${backupId}' -> s3://${storageConfig.bucket}/${storagePath}`,
  );

  return jobName;
}

export function buildBackupDeleteJob(
  jobName: string,
  backupId: string,
  serverId: string,
  storagePath: string,
  storageConfig: BackupStorageConfig = resolveBackupStorageConfig(),
): k8s.V1Job {
  return {
    metadata: {
      name: jobName,
      namespace: NAMESPACE,
      labels: {
        app: "server-backup-delete-worker",
        "farlands.dev/server-id": serverId,
        "farlands.dev/backup-id": backupId,
        "farlands.dev/backup-operation": "delete",
      },
    },
    spec: {
      ttlSecondsAfterFinished: 3600,
      backoffLimit: 2,
      template: {
        metadata: {
          labels: {
            app: "server-backup-delete-worker",
            "farlands.dev/server-id": serverId,
            "farlands.dev/backup-id": backupId,
            "farlands.dev/backup-operation": "delete",
          },
        },
        spec: {
          serviceAccountName: SERVICE_ACCOUNT,
          restartPolicy: "OnFailure",
          containers: [
            {
              name: "delete-backup",
              image: UPLOAD_IMAGE,
              command: [
                "/bin/sh",
                "-c",
                'aws s3 rm "s3://${BACKUP_BUCKET}/${STORAGE_PATH}" --region "${AWS_REGION}"',
              ],
              env: [
                { name: "BACKUP_BUCKET", value: storageConfig.bucket },
                { name: "STORAGE_PATH", value: storagePath },
                { name: "AWS_REGION", value: storageConfig.region },
              ],
            },
          ],
        },
      },
    },
  };
}

/**
 * Dispatches a Kubernetes Job that replaces a stopped server's PVC contents
 * with a completed archive from S3. The archive is downloaded into an
 * emptyDir before the restore container touches the PVC, so a download failure
 * cannot leave the server data partially erased.
 */
export async function dispatchBackupRestoreJob(
  backupId: string,
  serverId: string,
  pvcName: string,
  storagePath: string,
): Promise<string> {
  const storageConfig = resolveBackupStorageConfig();
  const ts = isoTimestamp();
  const jobName = sanitizeJobName(`restore-${backupId}-${ts}`);
  const { batch } = makeKubernetesClients();
  const jobSpec = buildBackupRestoreJob(
    jobName,
    backupId,
    serverId,
    pvcName,
    storagePath,
    storageConfig,
  );

  await batch.createNamespacedJob({ namespace: NAMESPACE, body: jobSpec });

  console.info(
    `[backup] Dispatched restore job '${jobName}' for backup '${backupId}' from s3://${storageConfig.bucket}/${storagePath}`,
  );

  return jobName;
}

export function buildBackupRestoreJob(
  jobName: string,
  backupId: string,
  serverId: string,
  pvcName: string,
  storagePath: string,
  storageConfig: BackupStorageConfig = resolveBackupStorageConfig(),
): k8s.V1Job {
  return {
    metadata: {
      name: jobName,
      namespace: NAMESPACE,
      labels: {
        app: "server-backup-restore-worker",
        "farlands.dev/server-id": serverId,
        "farlands.dev/backup-id": backupId,
        "farlands.dev/backup-operation": "restore",
      },
    },
    spec: {
      ttlSecondsAfterFinished: 3600,
      backoffLimit: 2,
      template: {
        metadata: {
          labels: {
            app: "server-backup-restore-worker",
            "farlands.dev/server-id": serverId,
            "farlands.dev/backup-id": backupId,
            "farlands.dev/backup-operation": "restore",
          },
        },
        spec: {
          serviceAccountName: SERVICE_ACCOUNT,
          restartPolicy: "OnFailure",
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
              name: "download-backup",
              image: UPLOAD_IMAGE,
              command: [
                "/bin/sh",
                "-c",
                'aws s3 cp "s3://${BACKUP_BUCKET}/${STORAGE_PATH}" /backup/restore.tar.gz --region "${AWS_REGION}"',
              ],
              env: [
                { name: "BACKUP_BUCKET", value: storageConfig.bucket },
                { name: "STORAGE_PATH", value: storagePath },
                { name: "AWS_REGION", value: storageConfig.region },
              ],
              volumeMounts: [{ name: "backup-temp", mountPath: "/backup" }],
            },
          ],
          containers: [
            {
              name: "restore-backup",
              image: ARCHIVE_IMAGE,
              command: [
                "/bin/sh",
                "-c",
                "find /world -mindepth 1 -maxdepth 1 -exec rm -rf -- {} \\; && tar -xzf /backup/restore.tar.gz -C /world",
              ],
              volumeMounts: [
                { name: "server-data", mountPath: "/world" },
                { name: "backup-temp", mountPath: "/backup", readOnly: true },
              ],
            },
          ],
          volumes: [
            {
              name: "server-data",
              persistentVolumeClaim: { claimName: pvcName },
            },
            { name: "backup-temp", emptyDir: {} },
          ],
        },
      },
    },
  };
}

/**
 * Reads the Job created for one API backup record. The backup ID label is
 * unique to that request, so it cannot accidentally reconcile another
 * server's backup.
 */
export async function getBackupJobState(backupId: string): Promise<BackupJobState> {
  const { batch } = makeKubernetesClients();
  const jobs = await batch.listNamespacedJob({
    namespace: NAMESPACE,
    labelSelector: `farlands.dev/backup-id=${backupId}`,
  });

  const job = jobs.items
    .filter((item) => item.metadata?.name)
    .sort(
      (left, right) =>
        (right.metadata?.creationTimestamp?.getTime() ?? 0) -
        (left.metadata?.creationTimestamp?.getTime() ?? 0),
    )[0];

  if (!job?.metadata?.name) return { status: "pending" };

  const operation = job.metadata.labels?.["farlands.dev/backup-operation"];
  if (!operation) return { status: "pending" };

  if (
    job.status?.conditions?.some(
      (condition) => condition.type === "Complete" && condition.status === "True",
    )
  ) {
    return { status: "completed", jobName: job.metadata.name, operation };
  }

  if (
    job.status?.conditions?.some(
      (condition) => condition.type === "Failed" && condition.status === "True",
    )
  ) {
    return { status: "failed", jobName: job.metadata.name, operation };
  }

  return { status: "pending" };
}
