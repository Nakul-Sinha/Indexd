import { backups, gameServers, serverConfigs, userQuotas } from "@repo/db";
import { and, count, eq, ne, sql } from "drizzle-orm";
import { status } from "elysia";
import { db, type TransactionType } from "../../db";
import { headroomHeldByUser } from "./headroom";

export abstract class QuotaService {
  // Resources are per server basis.
  static async getResourceLimits(userId: string, tx: TransactionType) {
    const [quota] = await tx
      .select()
      .from(userQuotas)
      .where(eq(userQuotas.userId, userId))
      .for("update");

    if (!quota) return null;
    const [serverData] = await tx
      .select({
        used: count(gameServers.id),
      })
      .from(gameServers)
      .where(
        and(
          eq(gameServers.userId, userId),
          ne(gameServers.currentState, "deleted"),
          ne(gameServers.currentState, "failed"),
        ),
      );

    return {
      serversLimit: quota.serversLimit,
      serversUsed: serverData.used,
      cpuLimit: quota.cpuLimit,
      ramLimitMb: quota.ramLimitMb,
      storageLimitGb: quota.storageLimitGb,
    };
  }

  static async getBackupUsage(userId: string) {
    const [result] = await db
      .select({
        backupsLimit: userQuotas.backupsLimit,

        backupsUsed: sql`
          COUNT(DISTINCT ${backups.id})
        `.mapWith(Number),
      })
      .from(userQuotas)
      .leftJoin(
        gameServers,
        and(eq(gameServers.userId, userQuotas.userId), ne(gameServers.currentState, "deleted")),
      )
      .leftJoin(
        backups,
        and(
          eq(backups.serverId, gameServers.id),
          ne(backups.status, "deleted"),
          ne(backups.status, "failed"),
        ),
      )
      .where(eq(userQuotas.userId, userId))
      .groupBy(userQuotas.userId, userQuotas.backupsLimit);

    return result;
  }

  static async getResourceUsage(userId: string) {
    const [quota] = await db.select().from(userQuotas).where(eq(userQuotas.userId, userId));

    if (!quota) return null;

    const servers = await db
      .select({
        cpuCores: serverConfigs.cpuCores,
        ramMb: serverConfigs.ramMb,
        storageGb: serverConfigs.storageGb,
      })
      .from(gameServers)
      .innerJoin(serverConfigs, eq(serverConfigs.serverId, gameServers.id))
      .where(
        and(
          eq(gameServers.userId, userId),
          ne(gameServers.currentState, "deleted"),
          ne(gameServers.currentState, "failed"),
        ),
      );

    let cpuUsed = 0;
    let ramUsedMb = 0;
    let storageUsedGb = 0;

    for (const server of servers) {
      cpuUsed += Number(server.cpuCores) || 0;
      ramUsedMb += server.ramMb || 0;
      storageUsedGb += server.storageGb || 0;
    }

    return {
      cpuLimit: quota.cpuLimit,
      cpuUsed: String(cpuUsed),

      ramLimitMb: quota.ramLimitMb,
      ramUsedMb,

      storageLimitGb: quota.storageLimitGb,
      storageUsedGb,

      serversLimit: quota.serversLimit,
      serversUsed: servers.length,
      deploymentHeadroomReserved: headroomHeldByUser(userId),
    };
  }

  /**
   * Validates whether restarting a failed server would exceed quota limits.
   * Called before transitioning a server from failed -> running state.
   *
   * Throws 403 status error if any limit would be exceeded.
   * Returns silently if quota is satisfied.
   */
  static async validateRestartQuota(userId: string, serverId: string) {
    // Fetch the quota limits and current usage
    const [quota] = await db.select().from(userQuotas).where(eq(userQuotas.userId, userId));

    if (!quota) throw status(404, "No quota found for this account.");

    // Fetch the server being restarted (must be in failed state)
    const [server] = await db
      .select({
        cpuCores: serverConfigs.cpuCores,
        ramMb: serverConfigs.ramMb,
        storageGb: serverConfigs.storageGb,
      })
      .from(gameServers)
      .innerJoin(serverConfigs, eq(serverConfigs.serverId, gameServers.id))
      .where(eq(gameServers.id, serverId));

    if (!server) throw status(404, "Server or server configuration not found");

    // Get current usage (excludes failed and deleted servers)
    const servers = await db
      .select({
        cpuCores: serverConfigs.cpuCores,
        ramMb: serverConfigs.ramMb,
        storageGb: serverConfigs.storageGb,
      })
      .from(gameServers)
      .innerJoin(serverConfigs, eq(serverConfigs.serverId, gameServers.id))
      .where(
        and(
          eq(gameServers.userId, userId),
          ne(gameServers.currentState, "deleted"),
          ne(gameServers.currentState, "failed"),
        ),
      );

    let cpuUsed = 0;
    let ramUsedMb = 0;
    let storageUsedGb = 0;

    for (const srv of servers) {
      cpuUsed += Number(srv.cpuCores) || 0;
      ramUsedMb += srv.ramMb || 0;
      storageUsedGb += srv.storageGb || 0;
    }

    // Get current server count (excludes failed and deleted)
    const [serverCountResult] = await db
      .select({
        count: count(gameServers.id),
      })
      .from(gameServers)
      .where(
        and(
          eq(gameServers.userId, userId),
          ne(gameServers.currentState, "deleted"),
          ne(gameServers.currentState, "failed"),
        ),
      );

    const currentServersUsed = serverCountResult.count;

    // Calculate projected usage if this server is restarted
    const projectedServers = currentServersUsed + 1;
    const projectedCpu = cpuUsed + (Number(server.cpuCores) || 0);
    const projectedRam = ramUsedMb + server.ramMb;
    const projectedStorage = storageUsedGb + server.storageGb;

    // Validate against limits
    if (projectedServers > quota.serversLimit) {
      throw status(
        403,
        `Restarting this server would exceed your server limit. Current: ${currentServersUsed}, Limit: ${quota.serversLimit}`,
      );
    }

    if (projectedCpu > Number(quota.cpuLimit)) {
      throw status(
        403,
        `Restarting this server would exceed your CPU limit. This server requires ${server.cpuCores} cores. Current usage: ${cpuUsed}, Available: ${quota.cpuLimit}`,
      );
    }

    if (projectedRam > quota.ramLimitMb) {
      throw status(
        403,
        `Restarting this server would exceed your RAM limit. This server requires ${server.ramMb}MB. Current usage: ${ramUsedMb}MB, Available: ${quota.ramLimitMb}MB`,
      );
    }

    if (projectedStorage > quota.storageLimitGb) {
      throw status(
        403,
        `Restarting this server would exceed your storage limit. This server requires ${server.storageGb}GB. Current usage: ${storageUsedGb}GB, Available: ${quota.storageLimitGb}GB`,
      );
    }
  }
}
