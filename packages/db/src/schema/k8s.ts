import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { k8sEventTypeEnum } from "./enums";
import { gameServers } from "./servers";

export const serverK8s = pgTable("server_k8s", {
  id: text("id").primaryKey(),
  serverId: text("server_id")
    .notNull()
    .unique()
    .references(() => gameServers.id, { onDelete: "cascade" }),

  // Renamed from statefulSetName to deploymentName: confirmed that
  // game servers run as plain Kubernetes Deployments, not StatefulSets.
  // pvcName is still required since world save data still needs a dedicated
  // PVC mounted into the Deployment's pod spec, even without StatefulSet's
  // automatic per-replica volumeClaimTemplate.
  deploymentName: text("deployment_name").notNull(),
  namespace: text("namespace").notNull(),
  serviceName: text("service_name").notNull(),
  podName: text("pod_name"),
  clusterName: text("cluster_name"),
  pvcName: text("pvc_name").notNull(),
  extraEnv: jsonb("extra_env").default([]),

  generatedYaml: text("generated_yaml"),
  yamlGeneratedAt: timestamp("yaml_generated_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const k8sEvents = pgTable(
  "k8s_events",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => gameServers.id, { onDelete: "cascade" }),

    type: k8sEventTypeEnum("type").notNull(),
    message: text("message"),
    reason: text("reason"),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("k8s_events_server_id_idx").on(table.serverId),
    index("k8s_events_type_idx").on(table.type),
    index("k8s_events_occurred_at_idx").on(table.occurredAt),
  ],
);
