-- Rename duplicate active server names (keep oldest per user/name) before adding the index.
-- Append a random suffix so the new name cannot collide with a user-chosen name or a
-- prior dedupe/restore, even if someone already owns dedupe-<id> or similar.
UPDATE "game_servers" AS gs
SET
  "name" = 'dedupe-' || left(gen_random_uuid()::text, 8),
  "updated_at" = NOW()
FROM (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "user_id", "name"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS rn
  FROM "game_servers"
  WHERE "current_state" <> 'deleted'
) AS duplicates
WHERE gs."id" = duplicates."id"
  AND duplicates.rn > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "game_servers_user_active_name_idx" ON "game_servers" USING btree ("user_id","name") WHERE "game_servers"."current_state" <> 'deleted';
