import { Elysia } from "elysia";
import { z } from "zod";

const createBackupDto = z
  .object({
    name: z.string().min(1).max(100).optional(),
  })
  .default({});

export type BackupCreateInput = z.infer<typeof createBackupDto>;
export const BackupModel = new Elysia({ name: "backup.model" }).model({
  "backup.create": createBackupDto,
});
