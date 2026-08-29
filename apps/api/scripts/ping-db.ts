import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}

const client = new Client({ connectionString: url });
try {
  await client.connect();
  const r = await client.query("select current_database() as db, now() as now");
  console.log("ok", r.rows[0]?.db, r.rows[0]?.now);
} catch (error) {
  console.error("connect failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
