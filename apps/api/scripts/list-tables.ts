import { Client } from "pg";

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const r = await client.query(
  "select table_name from information_schema.tables where table_schema='public' order by 1",
);
console.log(r.rows.map((row: { table_name: string }) => row.table_name).join("\n"));
await client.end();
