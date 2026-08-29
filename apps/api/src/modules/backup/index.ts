import { Elysia } from "elysia";
import z from "zod";
import { AuthService } from "../auth/service";
import { BackupModel } from "./model";
import { BackupService } from "./service";

const serverParams = z.object({
  serverId: z.string(),
});

const backupParams = z.object({
  serverId: z.string(),
  backupId: z.string(),
});

export const BackupModule = new Elysia({ prefix: "/backups" })
  .use(BackupModel)
  .derive(async ({ headers }) => ({
    userId: await AuthService.requireUserId(headers.cookie ?? ""),
  }))

  .get(
    "/",
    async ({ params: { serverId }, userId }) => {
      const backups = await BackupService.getAllByServer(userId, serverId);
      return { success: true, data: backups };
    },
    { params: serverParams },
  )

  .get(
    "/:backupId",
    async ({ params: { serverId, backupId }, userId }) => {
      const backup = await BackupService.getById(userId, serverId, backupId);
      return { success: true, data: backup };
    },
    { params: backupParams },
  )

  .post(
    "/",
    async ({ params: { serverId }, body, userId, set }) => {
      const result = await BackupService.create(userId, serverId, body);
      set.status = 201;
      return { success: true, data: result };
    },
    {
      params: serverParams,
      body: "backup.create",
    },
  )

  .post(
    "/:backupId/restore",
    async ({ params: { serverId, backupId }, userId }) => {
      const result = await BackupService.restore(backupId, serverId, userId);
      return { success: true, data: result };
    },
    { params: backupParams },
  )

  .delete(
    "/:backupId",
    async ({ params: { serverId, backupId }, userId }) => {
      const deletedBackup = await BackupService.delete(backupId, serverId, userId);
      return { success: true, data: deletedBackup };
    },
    { params: backupParams },
  );
