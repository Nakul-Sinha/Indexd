import { bigint, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { backupEventTypeEnum, backupStatusEnum, logLevelEnum } from "./enums";
import { gameServers } from "./servers";

export const backups = pgTable(
  "backups",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => gameServers.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    storagePath: text("storage_path").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    status: backupStatusEnum("status").notNull().default("pending"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    index("backups_server_id_idx").on(table.serverId),
    index("backups_status_idx").on(table.status),
    index("backups_expires_at_idx").on(table.expiresAt),
  ],
);

export const backupLogs = pgTable(
  "backup_logs",
  {
    id: text("id").primaryKey(),

    backupId: text("backup_id")
      .notNull()
      .references(() => backups.id, { onDelete: "cascade" }),

    serverId: text("server_id")
      .notNull()
      .references(() => gameServers.id, { onDelete: "cascade" }),

    level: logLevelEnum("level").notNull(),
    eventType: backupEventTypeEnum("event_type").notNull(),
    message: text("message").notNull(),
    metadata: jsonb("metadata"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("backup_logs_server_id_idx").on(table.serverId),
    index("backup_logs_backup_id_time_idx").on(table.backupId, table.createdAt),
  ],
);
