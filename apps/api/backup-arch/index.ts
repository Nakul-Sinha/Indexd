import * as k8s from "@kubernetes/client-node";

const NAMESPACE = requireEnv("NAMESPACE");
const LABEL_SELECTOR = requireEnv("PVC_LABEL_SELECTOR");
const S3_BUCKET = requireEnv("S3_BUCKET");
const S3_REGION = requireEnv("S3_REGION");
const S3_PREFIX = requireEnv("S3_PREFIX");
const ARCHIVE_IMAGE = requireEnv("BACKUP_IMAGE_ARCHIVE");
const UPLOAD_IMAGE = requireEnv("BACKUP_IMAGE_UPLOAD");
const SERVICE_ACCOUNT = requireEnv("BACKUP_SERVICE_ACCOUNT");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function timestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

function sanitizeJobName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 63);
}

const kc = new k8s.KubeConfig();
kc.loadFromCluster();
const core = kc.makeApiClient(k8s.CoreV1Api);
const batch = kc.makeApiClient(k8s.BatchV1Api);

async function main() {
  const pvcs = await core.listNamespacedPersistentVolumeClaim({
    namespace: NAMESPACE,
    labelSelector: LABEL_SELECTOR,
  });

  if (pvcs.items.length === 0) {
    console.info("No PVCs matched label selector; nothing to back up.");
    return;
  }

  const results = await Promise.allSettled(
    pvcs.items.map((pvc) => createBackupJob(pvc))
  );

  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    console.error(
      `${failed.length} of ${results.length} backup jobs failed to create`
    );
    for (const f of failed) {
      if (f.status === "rejected") console.error(f.reason);
    }
    process.exitCode = 1;
  }
}

async function createBackupJob(
  pvc: k8s.V1PersistentVolumeClaim
): Promise<void> {
  const pvcName = pvc.metadata?.name;
  const serverId = pvc.metadata?.labels?.["farlands.dev/server-id"];

  if (!pvcName) {
    console.warn("Skipping PVC with no name (unexpected)");
    return;
  }

  if (!serverId) {
    console.warn(`Skipping ${pvcName}: missing farlands.dev/server-id label`);
    return;
  }

  const ts = timestamp();
  const jobName = sanitizeJobName(`backup-${serverId}-${ts}`);
  const archiveFile = `${serverId}-${ts}.tar.gz`;
  const s3Key = `${S3_PREFIX}/${serverId}/${archiveFile}`;

  await batch.createNamespacedJob({
    namespace: NAMESPACE,
    body: {
      metadata: {
        name: jobName,
        labels: {
          app: "server-backup-worker",
          "farlands.dev/server-id": serverId,
        },
      },
      spec: {
        ttlSecondsAfterFinished: 3600,
        backoffLimit: 2,
        template: {
          metadata: {
            labels: {
              app: "server-backup-worker",
              "farlands.dev/server-id": serverId,
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
                  `apk add --no-cache tar && tar -czf /backup/${archiveFile} -C /world .`,
                ],
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
                  `aws s3 cp /backup/${archiveFile} s3://${S3_BUCKET}/${s3Key} --region ${S3_REGION}`,
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
    },
  });

  console.info(
    `Created backup job ${jobName} for server ${serverId} -> s3://${S3_BUCKET}/${s3Key}`
  );
}

main().catch((err) => {
  console.error("Orchestrator failed:", err);
  process.exit(1);
});
