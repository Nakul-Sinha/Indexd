import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { users } from "./auth";
import { planEnum } from "./enums";

export const userQuotas = pgTable("user_quotas", {
  userId: text("user_id")
    .primaryKey()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  plan: planEnum("plan").notNull().default("starter"),
  serversLimit: integer("servers_limit").notNull().default(1),
  ramLimitMb: integer("ram_limit_mb").notNull().default(2048),
  cpuLimit: text("cpu_limit").notNull().default("2"),
  storageLimitGb: integer("storage_limit_gb").notNull().default(5),
  backupsLimit: integer("backups_limit").notNull().default(3),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
