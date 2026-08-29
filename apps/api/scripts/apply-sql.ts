import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error("usage: apply-sql.ts <file>");
  process.exit(1);
}

const sql = readFileSync(resolve(file), "utf8");
const statements = sql
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

const client = new Client({ connectionString: url });
await client.connect();
await client.query("SET statement_timeout = '20s'");
console.log(`applying ${statements.length} statements from ${file}`);
try {
  for (const [i, statement] of statements.entries()) {
    process.stdout.write(`  [${i + 1}/${statements.length}] `);
    try {
      await client.query(statement);
      console.log("ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already exists/i.test(message) || /duplicate/i.test(message)) {
        console.log("skip (exists)");
        continue;
      }
      console.log("FAIL");
      console.error(message);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await client.end();
}
