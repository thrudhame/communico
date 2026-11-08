// Tenant-first E2EE roll-forward, serialized with room publication projection.
import type { Store } from '#engine/store/index.ts';
import { withProjectionLock } from '#engine/server/project.ts';
import { advance, get } from '#engine/store/watermark.ts';

export function projectTenant(store: Store, tenant: string): Promise<void> {
  return withProjectionLock(async () => {
    const server = await store.server(), db = await store.tenant(tenant);
    const source = 'tenant:' + tenant + ':e2ee';
    for (;;) {
      const mark = await get(server, source);
      const rows = await db.query(
        'SELECT * FROM e2ee_changes WHERE pos>? ORDER BY pos LIMIT 500',
        [mark],
      );
      if (!rows.length) return;
      await server.tx(async (conn) => {
        for (const row of rows) {
          const old = await conn.query(
            'SELECT seq FROM device_changes WHERE source=? AND source_pos=?',
            [source, row.pos],
          );
          if (old.length) continue;
          await conn.execute(
            "INSERT INTO counters VALUES('devices',0) ON CONFLICT(name) DO NOTHING",
          );
          await conn.execute(
            "UPDATE counters SET value=value+1 WHERE name='devices'",
          );
          const seq = await conn.query(
            "SELECT value FROM counters WHERE name='devices'",
          );
          await conn.execute(
            'INSERT INTO device_changes VALUES(?,?,?,?,?,?,?,?)',
            [
              Number(seq[0].value),
              source,
              row.pos,
              '@' + row.localpart + ':' + tenant,
              row.device_id,
              row.generation,
              row.stream_id,
              row.payload,
            ],
          );
        }
        await advance(conn, source, Number(rows[rows.length - 1].pos));
      });
    }
  });
}
