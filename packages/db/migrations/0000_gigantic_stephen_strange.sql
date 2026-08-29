CREATE TYPE "public"."backup_event_type" AS ENUM('backup_started', 'backup_completed', 'backup_failed', 'backup_deleted', 'restore_started', 'restore_completed', 'restore_failed');--> statement-breakpoint
CREATE TYPE "public"."backup_status" AS ENUM('pending', 'in_progress', 'completed', 'failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."desired_state" AS ENUM('ready', 'running', 'stopped', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."extension_source" AS ENUM('modrinth', 'curseforge', 'steam_workshop', 'user_created');--> statement-breakpoint
CREATE TYPE "public"."extension_type" AS ENUM('plugin', 'mod');--> statement-breakpoint
CREATE TYPE "public"."extension_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."game_type" AS ENUM('minecraft', 'rust', 'cs2');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'blocked', 'processing', 'completed', 'failed', 'exhausted', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('provision', 'start', 'stop', 'restart', 'reconfigure', 'delete', 'extension_install', 'extension_remove', 'backup_create', 'backup_restore', 'backup_delete');--> statement-breakpoint
CREATE TYPE "public"."k8s_event_type" AS ENUM('pod_ready', 'pod_started', 'pod_stopped', 'pod_crashed', 'pod_restarted', 'oom_killed', 'image_pull_error', 'scheduling_failed', 'volume_mount_error', 'crash_loop_backoff', 'pod_not_ready');--> statement-breakpoint
CREATE TYPE "public"."log_level" AS ENUM('info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('starter', 'standard', 'pro');--> statement-breakpoint
CREATE TYPE "public"."server_status" AS ENUM('ready', 'running', 'stopped', 'deleted', 'provisioning', 'starting', 'stopping', 'restarting', 'failed');--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "accounts" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verifications" USING btree ("identifier");
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "game_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"user_id" text NOT NULL,
	"game" "game_type" NOT NULL,
	"current_state" "server_status" DEFAULT 'provisioning' NOT NULL,
	"desired_state" "desired_state" DEFAULT 'ready' NOT NULL,
	"status_message" text,
	"last_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"version" text,
	"game_config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cpu_cores" text NOT NULL,
	"ram_mb" integer NOT NULL,
	"storage_gb" integer DEFAULT 5 NOT NULL,
	"storage_class" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_configs_server_id_unique" UNIQUE("server_id")
);
--> statement-breakpoint
CREATE TABLE "server_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"hostname" text,
	"proxy_target" text,
	"ip" text,
	"port" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_routes_server_id_unique" UNIQUE("server_id")
);
--> statement-breakpoint
CREATE TABLE "k8s_events" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"type" "k8s_event_type" NOT NULL,
	"message" text,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_k8s" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"stateful_set_name" text NOT NULL,
	"namespace" text NOT NULL,
	"service_name" text NOT NULL,
	"pod_name" text,
	"cluster_name" text,
	"pvc_name" text NOT NULL,
	"extra_env" jsonb DEFAULT '[]'::jsonb,
	"generated_yaml" text,
	"yaml_generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_k8s_server_id_unique" UNIQUE("server_id")
);
--> statement-breakpoint
CREATE TABLE "server_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"type" "job_type" NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"depends_on_job_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"next_retry_at" timestamp with time zone,
	"yaml_snapshot" text,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "backup_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"backup_id" text NOT NULL,
	"server_id" text NOT NULL,
	"level" "log_level" NOT NULL,
	"event_type" "backup_event_type" NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"name" text NOT NULL,
	"storage_path" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"status" "backup_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "server_rule_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"created_by" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"game_type" "game_type" NOT NULL,
	"json_url" text NOT NULL,
	"version" text DEFAULT '1.0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_quotas" (
	"user_id" text PRIMARY KEY NOT NULL,
	"plan" "plan" DEFAULT 'starter' NOT NULL,
	"servers_limit" integer DEFAULT 1 NOT NULL,
	"ram_limit_mb" integer DEFAULT 2048 NOT NULL,
	"cpu_limit" text DEFAULT '2' NOT NULL,
	"storage_limit_gb" integer DEFAULT 5 NOT NULL,
	"backups_limit" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extensions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"extension_type" "extension_type" NOT NULL,
	"game_type" "game_type" NOT NULL,
	"game_version" text NOT NULL,
	"extension_version" text DEFAULT '1.0' NOT NULL,
	"source" "extension_source",
	"external_id" text,
	"download_url" text,
	"owner_id" text,
	"visibility" "extension_visibility" DEFAULT 'public' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_extensions" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"extension_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game_servers" ADD CONSTRAINT "game_servers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_servers" ADD CONSTRAINT "game_servers_last_job_id_server_jobs_id_fk" FOREIGN KEY ("last_job_id") REFERENCES "public"."server_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_configs" ADD CONSTRAINT "server_configs_server_id_game_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."game_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_routes" ADD CONSTRAINT "server_routes_server_id_game_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."game_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "k8s_events" ADD CONSTRAINT "k8s_events_server_id_game_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."game_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_k8s" ADD CONSTRAINT "server_k8s_server_id_game_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."game_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_jobs" ADD CONSTRAINT "server_jobs_server_id_game_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."game_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_jobs" ADD CONSTRAINT "server_jobs_depends_on_job_id_server_jobs_id_fk" FOREIGN KEY ("depends_on_job_id") REFERENCES "public"."server_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_logs" ADD CONSTRAINT "backup_logs_backup_id_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_logs" ADD CONSTRAINT "backup_logs_server_id_game_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."game_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_server_id_game_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."game_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_rule_assignments" ADD CONSTRAINT "server_rule_assignments_server_id_game_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."game_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_rule_assignments" ADD CONSTRAINT "server_rule_assignments_rule_id_server_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."server_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_rules" ADD CONSTRAINT "server_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_quotas" ADD CONSTRAINT "user_quotas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_extensions" ADD CONSTRAINT "server_extensions_server_id_game_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."game_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_extensions" ADD CONSTRAINT "server_extensions_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_servers_user_id_idx" ON "game_servers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "game_servers_status_idx" ON "game_servers" USING btree ("current_state");--> statement-breakpoint
CREATE INDEX "server_routes_server_id_idx" ON "server_routes" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "server_routes_hostname_idx" ON "server_routes" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "k8s_events_server_id_idx" ON "k8s_events" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "k8s_events_type_idx" ON "k8s_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "k8s_events_occurred_at_idx" ON "k8s_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "server_jobs_server_id_idx" ON "server_jobs" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "server_jobs_queue_idx" ON "server_jobs" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "server_jobs_depends_on_idx" ON "server_jobs" USING btree ("depends_on_job_id");--> statement-breakpoint
CREATE INDEX "backup_logs_server_id_idx" ON "backup_logs" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "backup_logs_backup_id_time_idx" ON "backup_logs" USING btree ("backup_id","created_at");--> statement-breakpoint
CREATE INDEX "backups_server_id_idx" ON "backups" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "backups_status_idx" ON "backups" USING btree ("status");--> statement-breakpoint
CREATE INDEX "backups_expires_at_idx" ON "backups" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "server_rule_assignments_idx" ON "server_rule_assignments" USING btree ("server_id","rule_id");--> statement-breakpoint
CREATE INDEX "server_rules_created_by_idx" ON "server_rules" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "extension_owner_id_idx" ON "extensions" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "extensions_unique_version_idx" ON "extensions" USING btree ("name","game_type","game_version","extension_version");--> statement-breakpoint
CREATE UNIQUE INDEX "server_extensions_server_extensions_idx" ON "server_extensions" USING btree ("server_id","extension_id");
