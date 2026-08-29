import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "./auth";
import {
  extensionSourceEnum,
  extensionTypeEnum,
  extensionVisibilityEnum,
  gameTypeEnum,
} from "./enums";
import { gameServers } from "./servers";

export const extensions = pgTable(
  "extensions",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    extensionType: extensionTypeEnum("extension_type").notNull(),
    gameType: gameTypeEnum("game_type").notNull(),
    gameVersion: text("game_version").notNull(),
    extensionVersion: text("extension_version").notNull().default("1.0"),
    source: extensionSourceEnum("source"),
    externalId: text("external_id"),
    downloadUrl: text("download_url"),
    ownerId: text("owner_id").references(() => users.id, {
      onDelete: "set null",
    }),

    visibility: extensionVisibilityEnum("visibility").notNull().default("public"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("extension_owner_id_idx").on(table.ownerId),
    uniqueIndex("extensions_unique_version_idx").on(
      table.name,
      table.gameType,
      table.gameVersion,
      table.extensionVersion,
    ),
  ],
);

export const serverExtensions = pgTable(
  "server_extensions",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => gameServers.id, { onDelete: "cascade" }),
    extensionId: text("extension_id")
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),

    enabled: boolean("enabled").notNull().default(true),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("server_extensions_server_extensions_idx").on(table.serverId, table.extensionId),
  ],
);
