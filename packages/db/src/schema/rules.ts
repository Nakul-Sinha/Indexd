import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "./auth";
import { gameTypeEnum } from "./enums";
import { gameServers } from "./servers";

export const serverRules = pgTable(
  "server_rules",
  {
    id: text("id").primaryKey(),

    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    description: text("description"),
    gameType: gameTypeEnum("game_type").notNull(),

    jsonUrl: text("json_url").notNull(),

    version: text("version").notNull().default("1.0"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("server_rules_created_by_idx").on(table.createdBy)],
);

export const serverRuleAssignments = pgTable(
  "server_rule_assignments",
  {
    id: text("id").primaryKey(),

    serverId: text("server_id")
      .notNull()
      .references(() => gameServers.id, { onDelete: "cascade" }),
    ruleId: text("rule_id")
      .notNull()
      .references(() => serverRules.id, { onDelete: "cascade" }),

    isActive: boolean("is_active").notNull().default(true),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("server_rule_assignments_idx").on(table.serverId, table.ruleId)],
);
