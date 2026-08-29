# Elysia with Bun runtime

## Getting Started

To get started with this template, simply paste this command into your terminal:

```bash
bun create elysia ./elysia-example
```

## Development

To start the development server run:

```bash
bun run dev
```

Open http://localhost:3000/ with your browser to see the result.

## Backup completion

Creating a backup at `POST /api/servers/:serverId/backups/` creates a
server-labelled Kubernetes Job that mounts that server's PVC and uploads its
archive to S3. The returned backup begins as `pending`. A subsequent backup
detail request reconciles that record with the Kubernetes Job carrying the
same `farlands.dev/backup-id` label:

- a completed Job marks the backup `completed` and records the Job name in its
  backup log;
- a failed Job marks the backup `failed` and records the Job name in its error
  log.

The S3 sync worker also reconciles pending records when it can list the backup
bucket, including archive size and S3 modification time. It can be scoped to a
single object key by calling `syncBackupsFromS3(prefix)`.

Deleting a completed backup dispatches a separate labelled Kubernetes Job using
the in-cluster backup identity. The record remains `in_progress` until a backup
list or detail request observes that Job's result, then becomes `deleted` only
after the S3 deletion Job completes.

Restoring a completed backup at
`POST /api/servers/:serverId/backups/:backupId/restore` requires the game server
to be stopped. The server enters a transitional `restarting` state while a
labelled Kubernetes Job downloads the archive, replaces the PVC contents, and
extracts the backup. The API monitors and reconciles the Job result, returns the
server to `stopped`, and records `restore_completed` or `restore_failed`.
Backup list/detail requests and later power actions also reconcile durable Job
state after a backend restart. The backup remains `completed` and reusable if
restore fails.

See `docs/backup-api-guide.md` for create, restore, and delete verification plus
the frontend wiring pattern.
