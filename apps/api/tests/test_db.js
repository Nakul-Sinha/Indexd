import pg from "pg";

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
});

await c.connect();

const result = await c.query(`
  select table_name
  from information_schema.tables
  where table_schema='public'
  order by table_name
`);

console.table(result.rows);

await c.end();
