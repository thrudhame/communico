import { Pool } from 'pg';
import { config } from '#engine/config.ts';

const db = config().db;
const pool = new Pool({
  database: db.name,
  host: db.host,
  port: db.port,
  user: db.user,
  password: db.pass,
});

Deno.serve(async () => {
  const result = await pool.query('SHOW DATABASES');

  return new Response(JSON.stringify(result.rows), {
    headers: { 'content-type': 'application/json' },
  });
});
