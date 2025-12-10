import { Pool } from "pg";

const pool = new Pool({
  database: 'postgres', //Deno.env.get('DB_NAME'),
  host: Deno.env.get('DB_HOST'),
  user: Deno.env.get('DB_USER'),
  password: Deno.env.get('DB_PASS'),
});

Deno.serve(async () => {
  // Use the database
  const result = await pool.query("SHOW DATABASES");

  return new Response(JSON.stringify(result.rows), {
    headers: { "content-type": "application/json" },
  });
});
