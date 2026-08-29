export function getS3Bucket(): string {
  const bucket = process.env.S3_BUCKET;

  if (!bucket) {
    throw new Error("Missing required environment variable: S3_BUCKET");
  }

  return bucket;
}

export function getS3Prefix(): string {
  const prefix = process.env.S3_PREFIX ?? "plugin-builder/jsons/";

  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}
