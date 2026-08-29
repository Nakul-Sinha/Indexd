import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}

const pool = new Pool({ connectionString: url });
const db = drizzle(pool);

try {
  await migrate(db, {
    migrationsFolder: resolve(import.meta.dir, "../../../packages/db/migrations"),
  });
  console.log("migrations applied");
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
