import { join, resolve } from "node:path";
import { config } from "dotenv";

const repoRoot = resolve(import.meta.dir, "../../..");
config({ path: join(repoRoot, ".env") });
config({ path: join(import.meta.dir, "../.env") });

if (process.env.CONNECTION_STRING) {
  process.env.DATABASE_URL = process.env.CONNECTION_STRING;
}

if (!process.env.PGSSLROOTCERT && process.env.APPDATA) {
  process.env.PGSSLROOTCERT = join(process.env.APPDATA, "postgresql", "root.crt");
}

if (!process.env.AWS_REGION) {
  process.env.AWS_REGION = "ap-south-1";
}
