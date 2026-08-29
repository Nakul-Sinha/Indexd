import { describe, expect, test } from "bun:test";

import { parseBackupStorageKey, resolveBackupStorageConfig } from "../src/modules/backup/config";

describe("backup storage configuration", () => {
  test("prefers backup-specific bucket and prefix variables", () => {
    expect(
      resolveBackupStorageConfig({
        AWS_REGION: "ap-south-1",
        BACKUP_BUCKET: "backup-bucket",
        S3_BUCKET: "shared-bucket",
        BACKUP_S3_PREFIX: "/backup-prefix/",
        S3_PREFIX: "shared-prefix",
      }),
    ).toEqual({
      bucket: "backup-bucket",
      region: "ap-south-1",
      prefix: "backup-prefix",
    });
  });

  test("falls back to S3_BUCKET and S3_PREFIX", () => {
    expect(
      resolveBackupStorageConfig({
        AWS_REGION: "ap-south-1",
        BACKUP_BUCKET: "",
        S3_BUCKET: "shared-bucket",
        BACKUP_S3_PREFIX: "",
        S3_PREFIX: "shared-prefix/",
      }),
    ).toEqual({
      bucket: "shared-bucket",
      region: "ap-south-1",
      prefix: "shared-prefix",
    });
  });

  test("uses the default prefix when neither prefix variable is set", () => {
    expect(
      resolveBackupStorageConfig({
        AWS_REGION: "ap-south-1",
        BACKUP_BUCKET: "backup-bucket",
      }).prefix,
    ).toBe("infra-team");
  });

  test("rejects missing bucket, region, and empty normalized prefix", () => {
    expect(() => resolveBackupStorageConfig({ AWS_REGION: "ap-south-1" })).toThrow(
      "Missing BACKUP_BUCKET or S3_BUCKET",
    );
    expect(() => resolveBackupStorageConfig({ BACKUP_BUCKET: "backup-bucket" })).toThrow(
      "Missing AWS_REGION",
    );
    expect(() =>
      resolveBackupStorageConfig({
        AWS_REGION: "ap-south-1",
        BACKUP_BUCKET: "backup-bucket",
        BACKUP_S3_PREFIX: "/",
      }),
    ).toThrow("Backup S3 prefix must not be empty");
  });
});

describe("backup storage key parsing", () => {
  test("parses keys relative to a nested configured prefix", () => {
    expect(parseBackupStorageKey("team/backups/server-id/archive.tar.gz", "team/backups")).toEqual({
      serverId: "server-id",
      filename: "archive.tar.gz",
    });
  });

  test("rejects unrelated and malformed keys", () => {
    expect(parseBackupStorageKey("other/server-id/archive.tar.gz", "team/backups")).toBeNull();
    expect(
      parseBackupStorageKey("team/backups/extra/server-id/archive.tar.gz", "team/backups"),
    ).toBeNull();
  });
});
