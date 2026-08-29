import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "../packages/db/src/schema/index.ts",
  out: "../packages/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
