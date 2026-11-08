// Tenant-first E2EE roll-forward, serialized with room publication projection.
import type { Store } from '#engine/store/index.ts';
import { withProjectionLock } from '#engine/server/project.ts';
import { advance, get } from '#engine/store/watermark.ts';
import { nextDeviceSeq, publishDeviceChange } from '#engine/server/e2ee.ts';
import { enqueueEdu } from '#engine/server/delivery.ts';

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
      if (!rows.length) break;
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
    // Intents are not a lossy change-log instruction. Keep tenant admission
    // occupied until the server's durable completion, even after projection.
    const prefix = 'tenant:' + tenant + ':to-device:';
    const intents = await db.query(
      'SELECT source_id,destination,payload FROM to_device_intents',
    );
    for (const intent of intents) {
      const source = prefix + intent.source_id;
      const sent = await server.tx(async (conn) => {
        await enqueueEdu(
          conn,
          source,
          String(intent.destination),
          'm.direct_to_device',
          JSON.parse(String(intent.payload)),
        );
        const row = (await conn.query(
          'SELECT state FROM edu_outbox WHERE source=? AND destination=?',
          [source, intent.destination],
        ))[0];
        return row.state === 'sent';
      });
      if (sent) {
        await db.execute('DELETE FROM to_device_intents WHERE source_id=?', [
          intent.source_id,
        ]);
      }
    }
    // Tenant deletion precedes server pruning. A crash between them leaves a
    // harmless sent marker, never a chance to resurrect an accepted send.
    const remaining = new Set(
      (await db.query('SELECT source_id FROM to_device_intents')).map((r) =>
        prefix + r.source_id
      ),
    );
    for (
      const row of await server.query(
        "SELECT source,destination FROM edu_outbox WHERE state='sent' AND edu_type='m.direct_to_device'",
      )
    ) {
      const source = String(row.source);
      if (source.startsWith(prefix) && !remaining.has(source)) {
        await server.execute(
          "DELETE FROM edu_outbox WHERE source=? AND destination=? AND state='sent'",
          [source, row.destination],
        );
      }
    }
  });
}
