// Tenant-first E2EE roll-forward, serialized with room publication projection.
import type { Store } from '#engine/store/index.ts';
import { withProjectionLock } from '#engine/server/project.ts';
import { advance, get } from '#engine/store/watermark.ts';
import { nextDeviceSeq, publishDeviceChange } from '#engine/server/e2ee.ts';

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
          const seq = await nextDeviceSeq(conn);
          const subject = '@' + row.localpart + ':' + tenant;
          await conn.execute(
            'INSERT INTO device_changes VALUES(?,?,?,?,?,?,?,?)',
            [
              seq,
              source,
              row.pos,
              subject,
              row.device_id,
              row.generation,
              row.stream_id,
              row.payload,
            ],
          );
          await publishDeviceChange(conn, seq, subject);
        }
        await advance(conn, source, Number(rows[rows.length - 1].pos));
      });
    }
  });
}
