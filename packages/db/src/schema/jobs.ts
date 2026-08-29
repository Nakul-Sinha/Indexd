import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { jobStatusEnum, jobTypeEnum } from "./enums";
import { gameServers } from "./servers";

export const serverJobs = pgTable(
  "server_jobs",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => gameServers.id, { onDelete: "cascade" }),

    type: jobTypeEnum("type").notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),

    dependsOnJobId: text("depends_on_job_id").references((): AnyPgColumn => serverJobs.id, {
      onDelete: "set null",
    }),

    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),

    yamlSnapshot: text("yaml_snapshot"),
    payload: jsonb("payload").default({}),

    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("server_jobs_server_id_idx").on(table.serverId),
    index("server_jobs_queue_idx").on(table.status, table.nextRetryAt),
    index("server_jobs_depends_on_idx").on(table.dependsOnJobId),
  ],
);
