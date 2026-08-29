ALTER TYPE "public"."backup_event_type"
ADD VALUE IF NOT EXISTS 'delete_failed' BEFORE 'restore_started';
