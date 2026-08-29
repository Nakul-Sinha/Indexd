import { backupLogs, backups } from "@repo/db";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { parseBackupStorageKey, resolveBackupStorageConfig } from "./config";
import { listBackups } from "./s3";

export async function syncBackupsFromS3(prefix?: string) {
  const { prefix: configuredPrefix } = resolveBackupStorageConfig();
  const paginator = listBackups(prefix ?? `${configuredPrefix}/`);

  for await (const page of paginator) {
    if (!page.Contents) continue;

    for (const object of page.Contents) {
      if (!object.Key) continue;

      const parsedKey = parseBackupStorageKey(object.Key, configuredPrefix);
      if (!parsedKey) continue;
      const { serverId, filename } = parsedKey;

      const [existing] = await db.select().from(backups).where(eq(backups.storagePath, object.Key));

      if (existing) {
        // Backups created through the API already have a DB row before their
        // Kubernetes Job uploads the archive. Reconcile that pending row when
        // S3 confirms the exact key written by the Job.
        if (existing.status === "pending") {
          const completedAt = object.LastModified ?? new Date();
          const sizeBytes = Number(object.Size ?? 0);

          await db.transaction(async (tx) => {
            const [updated] = await tx
              .update(backups)
              .set({
                status: "completed",
                sizeBytes,
                completedAt,
              })
              .where(and(eq(backups.id, existing.id), eq(backups.status, "pending")))
              .returning({ id: backups.id });

            // Another sync may have already reconciled this key while this
            // transaction was waiting. Only that winning update writes the
            // completion log.
            if (!updated) return;

            await tx.insert(backupLogs).values({
              id: crypto.randomUUID(),
              backupId: existing.id,
              serverId: existing.serverId,
              level: "info",
              eventType: "backup_completed",
              message: `Backup '${existing.name}' completed.`,
              metadata: { sizeBytes },
            });
          });
        }

        continue;
      }

      await db.insert(backups).values({
        id: crypto.randomUUID(),
        serverId,
        name: filename,
        storagePath: object.Key,
        sizeBytes: Number(object.Size ?? 0),
        status: "completed",
        completedAt: object.LastModified ?? new Date(),
      });

      console.log(`Imported ${object.Key}`);
    }
  }
}
