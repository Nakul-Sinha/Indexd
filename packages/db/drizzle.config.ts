import { join } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: join(import.meta.dirname ?? ".", "../../.env") });
if (process.env.CONNECTION_STRING) {
  process.env.DATABASE_URL = process.env.CONNECTION_STRING;
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
