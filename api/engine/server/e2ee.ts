import type { Database } from '#engine/store/db.ts';

export async function deviceStreamMax(server: Database): Promise<number> {
  const rows = await server.query(
    "SELECT value FROM counters WHERE name='devices'",
  );
  return rows.length ? Number(rows[0].value) : 0;
}
