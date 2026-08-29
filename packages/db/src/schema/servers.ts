import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "./auth";
import { desiredStateEnum, gameTypeEnum, serverStatusEnum } from "./enums";

export const gameServers = pgTable(
  "game_servers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    game: gameTypeEnum("game").notNull(),

    currentState: serverStatusEnum("current_state").notNull().default("provisioning"),
    desiredState: desiredStateEnum("desired_state").notNull().default("ready"),
    statusMessage: text("status_message"),
    // Foreign key to server_jobs.id is enforced in the initial migration
    // (game_servers_last_job_id_server_jobs_id_fk) to avoid a circular
    // schema-dependency between game_servers and server_jobs.
    lastJobId: text("last_job_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("game_servers_user_id_idx").on(table.userId),
    index("game_servers_status_idx").on(table.currentState),
    uniqueIndex("game_servers_user_active_name_idx")
      .on(table.userId, table.name)
      .where(sql`${table.currentState} <> 'deleted'`),
  ],
);

export const serverConfigs = pgTable("server_configs", {
  id: text("id").primaryKey(),
  serverId: text("server_id")
    .notNull()
    .unique()
    .references(() => gameServers.id, { onDelete: "cascade" }),

  version: text("version"),
  type: text("type").notNull(),
  gameConfigJson: jsonb("game_config_json").notNull().default({}),

  cpuCores: text("cpu_cores").notNull(),
  ramMb: integer("ram_mb").notNull(),
  storageGb: integer("storage_gb").notNull().default(5),
  storageClass: text("storage_class").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const serverRoutes = pgTable(
  "server_routes",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .unique()
      .references(() => gameServers.id, { onDelete: "cascade" }),

    hostname: text("hostname"),
    proxyTarget: text("proxy_target"),
    ip: text("ip"),
    port: integer("port").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("server_routes_server_id_idx").on(table.serverId),
    uniqueIndex("server_routes_hostname_idx").on(table.hostname),
  ],
);
