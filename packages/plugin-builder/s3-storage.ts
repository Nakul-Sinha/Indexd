import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "../s3";
import { getS3Bucket, getS3Prefix } from "./s3-config";

export async function uploadPluginJson(key: string, json: object) {
  const bucket = getS3Bucket();
  const prefix = getS3Prefix();

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${prefix}${key}`,
      Body: JSON.stringify(json),
      ContentType: "application/json",
      CacheControl: "no-store",
    }),
  );
}
