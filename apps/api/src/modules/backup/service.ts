import { backupLogs, backups, gameServers, serverK8s, userQuotas } from "@repo/db";
import { and, count, desc, eq, inArray, ne, notInArray } from "drizzle-orm";
import { status } from "elysia";
import { db } from "../../db";
import { ServerService } from "../servers/service";
import { resolveBackupStorageConfig } from "./config";
import {
  dispatchBackupDeleteJob,
  dispatchBackupJob,
  dispatchBackupRestoreJob,
  getBackupJobState,
} from "./k8s-job";
import type { BackupCreateInput } from "./model";

export abstract class BackupService {
  private static readonly OPERATION_POLL_INTERVAL_MS = 2_000;
  private static readonly OPERATION_POLL_LIMIT = 450;

  static async getAllByServer(userId: string, serverId: string) {
    await ServerService.requireOwnership(userId, serverId);
    const allBackups = await db
      .select()
      .from(backups)
      .where(and(eq(backups.serverId, serverId), ne(backups.status, "deleted")))
      .orderBy(desc(backups.createdAt));
    return Promise.all(allBackups.map((backup) => this.reconcileBackupOperation(backup)));
  }

  static async getById(userId: string, serverId: string, backupId: string) {
    await ServerService.requireOwnership(userId, serverId);
    let [backup] = await db
      .select()
      .from(backups)
      .where(
        and(
          eq(backups.serverId, serverId),
          eq(backups.id, backupId),
          ne(backups.status, "deleted"),
        ),
      );
    if (!backup) throw status(404, "Backup not found");

    backup = await this.reconcileBackupOperation(backup);

    const logs = await db
      .select()
      .from(backupLogs)
      .where(eq(backupLogs.backupId, backupId))
      .orderBy(desc(backupLogs.createdAt));
    return {
      ...backup,
      logs,
    };
  }

  static async reconcileServerOperations(serverId: string) {
    const activeBackups = await db
      .select()
      .from(backups)
      .where(
        and(eq(backups.serverId, serverId), inArray(backups.status, ["pending", "in_progress"])),
      );

    return Promise.all(activeBackups.map((backup) => this.reconcileBackupOperation(backup)));
  }

  private static async monitorBackupOperation(backupId: string) {
    for (let attempt = 0; attempt < this.OPERATION_POLL_LIMIT; attempt += 1) {
      const [backup] = await db.select().from(backups).where(eq(backups.id, backupId));

      if (!backup || !["pending", "in_progress"].includes(backup.status)) {
        return;
      }

      const reconciled = await this.reconcileBackupOperation(backup);
      if (!["pending", "in_progress"].includes(reconciled.status)) return;

      await new Promise((resolve) => setTimeout(resolve, this.OPERATION_POLL_INTERVAL_MS));
    }

    console.error(`[backup] Timed out waiting to reconcile backup operation '${backupId}'`);
  }

  private static startBackupOperationMonitor(backupId: string) {
    void this.monitorBackupOperation(backupId).catch((error) => {
      // Read-time reconciliation and server-action recovery remain available if
      // this process is restarted or temporarily loses Kubernetes connectivity.
      console.error(`[backup] Background reconciliation failed for '${backupId}':`, error);
    });
  }

  private static async reconcileBackupOperation(backup: typeof backups.$inferSelect) {
    if (backup.status !== "pending" && backup.status !== "in_progress") {
      return backup;
    }

    const jobState = await getBackupJobState(backup.id);
    if (jobState.status === "pending") return backup;

    if (
      backup.status === "in_progress" &&
      jobState.operation !== "delete" &&
      jobState.operation !== "restore"
    ) {
      return backup;
    }

    if (backup.status === "pending" && jobState.operation !== "create") {
      return backup;
    }

    const deleted =
      backup.status === "in_progress" &&
      jobState.operation === "delete" &&
      jobState.status === "completed";
    const restored =
      backup.status === "in_progress" &&
      jobState.operation === "restore" &&
      jobState.status === "completed";
    const restoreFailed =
      backup.status === "in_progress" &&
      jobState.operation === "restore" &&
      jobState.status === "failed";
    const newStatus = deleted
      ? "deleted"
      : restored || restoreFailed
        ? "completed"
        : jobState.status === "completed"
          ? "completed"
          : "failed";
    const eventType = deleted
      ? "backup_deleted"
      : restored
        ? "restore_completed"
        : restoreFailed
          ? "restore_failed"
          : jobState.status === "completed"
            ? "backup_completed"
            : "backup_failed";
    const level = jobState.status === "failed" ? "error" : "info";
    const message = deleted
      ? `Backup '${backup.name}' was deleted by Kubernetes Job '${jobState.jobName}'.`
      : restored
        ? `Restore completed with Backup '${backup.name}' in Kubernetes Job '${jobState.jobName}'.`
        : restoreFailed
          ? `Restore failed for Backup '${backup.name}' in Kubernetes Job '${jobState.jobName}'.`
          : jobState.status === "completed"
            ? `Backup '${backup.name}' completed in Kubernetes Job '${jobState.jobName}'.`
            : `Backup '${backup.name}' failed in Kubernetes Job '${jobState.jobName}'.`;

    const [updatedBackup] = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(backups)
        .set({
          status: newStatus,
          storagePath: deleted ? "" : backup.storagePath,
          completedAt:
            jobState.operation === "create" && newStatus === "completed"
              ? new Date()
              : backup.completedAt,
        })
        .where(and(eq(backups.id, backup.id), eq(backups.status, backup.status)))
        .returning();

      if (!updated) return [backup];

      if (jobState.operation === "restore") {
        await tx
          .update(gameServers)
          .set({
            currentState: "stopped",
            desiredState: "stopped",
            statusMessage: restoreFailed ? "Backup restore failed" : null,
            updatedAt: new Date(),
          })
          .where(eq(gameServers.id, backup.serverId));
      }

      await tx.insert(backupLogs).values({
        id: crypto.randomUUID(),
        backupId: backup.id,
        serverId: backup.serverId,
        level,
        eventType,
        message,
        metadata: { jobName: jobState.jobName, operation: jobState.operation },
      });

      return [updated];
    });

    return updatedBackup;
  }

  static async create(userId: string, serverId: string, data: BackupCreateInput) {
    await ServerService.requireOwnership(userId, serverId);
    const { prefix: s3Prefix } = resolveBackupStorageConfig();
    const pendingBackup = await db.transaction(async (tx) => {
      const [server] = await tx
        .select({ currentState: gameServers.currentState })
        .from(gameServers)
        .where(eq(gameServers.id, serverId))
        .for("update");

      if (!server || server.currentState !== "running") {
        throw status(409, "Server must be running before creating a backup");
      }

      const [currentBackups] = await tx
        .select({ total: count() })
        .from(backups)
        .where(
          and(eq(backups.serverId, serverId), notInArray(backups.status, ["deleted", "failed"])),
        );

      const [quota] = await tx
        .select({ backupLimits: userQuotas.backupsLimit })
        .from(userQuotas)
        .where(eq(userQuotas.userId, userId));

      /**
       * Commented out utill quotas api is completed
       **/

      // User quota limit will be on per game server basis
      // ex: if set to 3 means each game server can have a max of 3 backups.
      // if(!quota){
      //   throw status(404, "User quota not found");
      // }

      // if (currentBackups.total >= quota.backupLimits) {
      //   // TODO: Delete old backup and create a new one without user intervention.
      //   throw status(403, "Quota limit reached");
      // }

      const [existingPending] = await tx
        .select({ id: backups.id })
        .from(backups)
        .where(
          and(eq(backups.serverId, serverId), inArray(backups.status, ["pending", "in_progress"])),
        );

      if (existingPending) {
        throw status(409, "A backup is already in progress for this server");
      }
      const timeString = new Date()
        .toISOString()
        .split(".")[0]
        .replace(/:/g, "-")
        .replace("T", "_");
      const [newBackup] = await tx
        .insert(backups)
        .values({
          id: crypto.randomUUID(),
          serverId: serverId,
          name: data.name || `Auto-Backup ${timeString}`,
          storagePath: "",
          sizeBytes: 0,
          status: "pending",
        })
        .returning();

      await tx.insert(backupLogs).values({
        id: crypto.randomUUID(),
        backupId: newBackup.id,
        serverId: serverId,
        level: "info",
        eventType: "backup_started",
        message: `Backup '${newBackup.name}' started.`,
        metadata: { sizeBytes: 0 },
      });
      return newBackup;
    });
    try {
      // Look up the PVC name for this server so we can tell the K8s job
      // which volume to archive.
      const k8sRecord = await db.query.serverK8s.findFirst({
        where: eq(serverK8s.serverId, serverId),
      });

      if (!k8sRecord) {
        throw new Error(`No Kubernetes record found for server '${serverId}'`);
      }

      // Build the S3 key ahead of time so the DB record and the job command
      // both point to the exact same object. The sync loop will match on this
      // path to flip the record from 'pending' → 'completed'.
      const ts = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "Z");
      const archiveFile = `${serverId}-${ts}.tar.gz`;
      const storagePath = `${s3Prefix}/${serverId}/${archiveFile}`;

      // Dispatch the K8s Job (same image/command pattern as the cronjob).
      // This returns immediately; the job runs in the background.
      await dispatchBackupJob(pendingBackup.id, serverId, k8sRecord.pvcName, storagePath);
      this.startBackupOperationMonitor(pendingBackup.id);

      // Record the expected storage path so the sync loop can match it.
      // Status stays 'pending' until the sync loop confirms the S3 object.
      return await db.transaction(async (tx) => {
        const [updatedBackup] = await tx
          .update(backups)
          .set({ storagePath })
          .where(eq(backups.id, pendingBackup.id))
          .returning();

        return updatedBackup;
      });
    } catch {
      await db.transaction(async (tx) => {
        const [failedBackup] = await tx
          .update(backups)
          .set({
            status: "failed",
          })
          .where(eq(backups.id, pendingBackup.id))
          .returning();

        await tx.insert(backupLogs).values({
          id: crypto.randomUUID(),
          backupId: failedBackup.id,
          serverId: serverId,
          level: "info",
          eventType: "backup_failed",
          message: `Backup '${failedBackup.name}' creation failed.`,
        });
      });
      throw status(500, "Backup creation failed.");
    }
  }

  static async restore(id: string, serverId: string, userId: string) {
    await ServerService.requireOwnership(userId, serverId);
    const restoreBackup = await db.transaction(async (tx) => {
      const [server] = await tx
        .select({ currentState: gameServers.currentState })
        .from(gameServers)
        .where(eq(gameServers.id, serverId))
        .for("update");

      if (!server || server.currentState !== "stopped") {
        throw status(409, "Server must be stopped before restoring a backup");
      }

      const [backup] = await tx
        .select()
        .from(backups)
        .where(
          and(eq(backups.serverId, serverId), eq(backups.id, id), eq(backups.status, "completed")),
        )
        .for("update");

      if (!backup) throw status(404, "Backup not found");
      if (!backup.storagePath.trim()) {
        throw status(409, "Backup has no storage object to restore");
      }

      // Claim both records in the same transaction. The transitional server
      // state prevents a concurrent start from mounting the PVC mid-restore.
      await tx.update(backups).set({ status: "in_progress" }).where(eq(backups.id, id));

      await tx
        .update(gameServers)
        .set({
          currentState: "restarting",
          desiredState: "stopped",
          statusMessage: "Restoring backup",
          updatedAt: new Date(),
        })
        .where(eq(gameServers.id, serverId));

      await tx.insert(backupLogs).values({
        id: crypto.randomUUID(),
        backupId: backup.id,
        serverId: serverId,
        level: "info",
        eventType: "restore_started",
        message: `Restore started with Backup '${backup.name}'`,
        metadata: {},
      });
      return backup;
    });
    try {
      const k8sRecord = await db.query.serverK8s.findFirst({
        where: eq(serverK8s.serverId, serverId),
      });

      if (!k8sRecord) {
        throw new Error(`No Kubernetes record found for server '${serverId}'`);
      }

      await dispatchBackupRestoreJob(
        restoreBackup.id,
        serverId,
        k8sRecord.pvcName,
        restoreBackup.storagePath,
      );
      this.startBackupOperationMonitor(restoreBackup.id);

      return { ...restoreBackup, status: "in_progress" as const };
    } catch {
      await db.transaction(async (tx) => {
        await tx
          .update(backups)
          .set({ status: "completed" })
          .where(eq(backups.id, restoreBackup.id));

        await tx
          .update(gameServers)
          .set({
            currentState: "stopped",
            desiredState: "stopped",
            statusMessage: "Backup restore failed",
            updatedAt: new Date(),
          })
          .where(eq(gameServers.id, serverId));

        await tx.insert(backupLogs).values({
          id: crypto.randomUUID(),
          backupId: restoreBackup.id,
          serverId: serverId,
          level: "error",
          eventType: "restore_failed",
          message: `Restore failed for Backup '${restoreBackup.name}'`,
        });
      });
      throw status(500, "Failed to restore backup.");
    }
  }

  static async delete(id: string, serverId: string, userId: string) {
    // Verify server ownership
    await ServerService.requireOwnership(userId, serverId);
    const backup = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(backups)
        .where(and(eq(backups.id, id), eq(backups.serverId, serverId)))
        .for("update");

      if (!existing || existing.status === "deleted") throw status(404, "Backup not found");
      if (existing.status === "in_progress" || existing.status === "pending")
        throw status(409, "This backup has an operation in progress, please try again later");

      if (!existing.storagePath.trim()) {
        const [deleted] = await tx
          .update(backups)
          .set({ storagePath: "", status: "deleted" })
          .where(eq(backups.id, id))
          .returning();

        await tx.insert(backupLogs).values({
          id: crypto.randomUUID(),
          backupId: existing.id,
          serverId: existing.serverId,
          level: "info",
          eventType: "backup_deleted",
          message: `Backup '${existing.name}' was removed without a storage deletion because it has no storage object.`,
          metadata: { operation: "delete", storageObjectExisted: false },
        });

        return {
          ...deleted,
          previousStatus: existing.status,
          requiresStorageDeletion: false,
        };
      }

      const [updated] = await tx
        .update(backups)
        .set({ status: "in_progress" })
        .where(eq(backups.id, id))
        .returning();

      return {
        ...updated,
        previousStatus: existing.status,
        requiresStorageDeletion: true,
      };
    });

    if (!backup.requiresStorageDeletion) return backup;

    try {
      await dispatchBackupDeleteJob(id, backup.serverId, backup.storagePath);
      this.startBackupOperationMonitor(backup.id);

      return backup;
    } catch {
      await db.transaction(async (tx) => {
        await tx.update(backups).set({ status: backup.previousStatus }).where(eq(backups.id, id));
        await tx.insert(backupLogs).values({
          id: crypto.randomUUID(),
          backupId: backup.id,
          serverId: backup.serverId,
          level: "error",
          eventType: "delete_failed",
          message: `Failed to delete Backup '${backup.name}'.`,
          metadata: {},
        });
      });
      throw status(500, "Failed to delete backup from storage.");
    }
  }
}
