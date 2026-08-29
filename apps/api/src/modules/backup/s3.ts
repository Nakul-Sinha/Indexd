import { DeleteObjectCommand, paginateListObjectsV2, S3Client } from "@aws-sdk/client-s3";
import { resolveBackupStorageConfig } from "./config";

const { region, bucket } = resolveBackupStorageConfig();

export const BUCKET = bucket;

export const s3 = new S3Client({
  region,
});

export function listBackups(prefix?: string) {
  return paginateListObjectsV2(
    {
      client: s3,
    },
    {
      Bucket: BUCKET,
      Prefix: prefix,
    },
  );
}

export async function deleteBackupObject(key: string) {
  return s3.send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key,
    }),
  );
}
