export type BackupStorageConfig = {
  bucket: string;
  region: string;
  prefix: string;
};

type BackupEnvironment = Record<string, string | undefined> &
  Partial<
    Record<
      "AWS_REGION" | "BACKUP_BUCKET" | "S3_BUCKET" | "BACKUP_S3_PREFIX" | "S3_PREFIX",
      string | undefined
    >
  >;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePrefix(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

export function resolveBackupStorageConfig(
  environment: BackupEnvironment = process.env,
): BackupStorageConfig {
  const bucket = nonEmpty(environment.BACKUP_BUCKET) ?? nonEmpty(environment.S3_BUCKET);
  const region = nonEmpty(environment.AWS_REGION);
  const configuredPrefix =
    nonEmpty(environment.BACKUP_S3_PREFIX) ?? nonEmpty(environment.S3_PREFIX) ?? "infra-team";
  const prefix = normalizePrefix(configuredPrefix);

  if (!bucket) {
    throw new Error("Missing BACKUP_BUCKET or S3_BUCKET");
  }
  if (!region) {
    throw new Error("Missing AWS_REGION");
  }
  if (!prefix) {
    throw new Error("Backup S3 prefix must not be empty");
  }

  return { bucket, region, prefix };
}

export function parseBackupStorageKey(
  storageKey: string,
  configuredPrefix: string,
): { serverId: string; filename: string } | null {
  const prefix = normalizePrefix(configuredPrefix);
  const prefixWithSeparator = `${prefix}/`;
  if (!prefix || !storageKey.startsWith(prefixWithSeparator)) return null;

  const relativeParts = storageKey.slice(prefixWithSeparator.length).split("/");
  if (relativeParts.length !== 2 || !relativeParts[0] || !relativeParts[1]) {
    return null;
  }

  return { serverId: relativeParts[0], filename: relativeParts[1] };
}
