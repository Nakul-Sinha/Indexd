// All enums
import { pgEnum } from "drizzle-orm/pg-core";

export const desiredStateEnum = pgEnum("desired_state", ["ready", "running", "stopped", "deleted"]);

export const serverStatusEnum = pgEnum("server_status", [
  "ready",
  "running",
  "stopped",
  "deleted",
  "provisioning",
  "starting",
  "stopping",
  "restarting",
  "failed",
]);

export const gameTypeEnum = pgEnum("game_type", ["minecraft", "rust", "cs2"]);

export const extensionSourceEnum = pgEnum("extension_source", [
  "modrinth",
  "curseforge",
  "steam_workshop",
  "user_created",
]);

export const extensionTypeEnum = pgEnum("extension_type", ["plugin", "mod"]);

export const extensionVisibilityEnum = pgEnum("extension_visibility", ["public", "private"]);

export const backupEventTypeEnum = pgEnum("backup_event_type", [
  "backup_started",
  "backup_completed",
  "backup_failed",
  "backup_deleted",
  "delete_failed",
  "restore_started",
  "restore_completed",
  "restore_failed",
]);

export const backupStatusEnum = pgEnum("backup_status", [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "deleted",
]);

export const k8sEventTypeEnum = pgEnum("k8s_event_type", [
  "pod_ready",
  "pod_started",
  "pod_stopped",
  "pod_crashed",
  "pod_restarted",
  "oom_killed",
  "image_pull_error",
  "scheduling_failed",
  "volume_mount_error",
  "crash_loop_backoff",
  "pod_not_ready",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "blocked",
  "processing",
  "completed",
  "failed",
  "exhausted",
  "cancelled",
]);

export const jobTypeEnum = pgEnum("job_type", [
  "provision",
  "start",
  "stop",
  "restart",
  "reconfigure",
  "delete",
  "extension_install",
  "extension_remove",
  "backup_create",
  "backup_restore",
  "backup_delete",
]);

export const planEnum = pgEnum("plan", ["starter", "standard", "pro"]);

export const logLevelEnum = pgEnum("log_level", ["info", "warn", "error"]);
