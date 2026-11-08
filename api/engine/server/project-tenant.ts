// Tenant-first E2EE roll-forward, serialized with room publication projection.
import type { Store } from '#engine/store/index.ts';
import { withProjectionLock } from '#engine/server/project.ts';
import { advance, get } from '#engine/store/watermark.ts';
import { nextDeviceSeq, publishDeviceChange } from '#engine/server/e2ee.ts';
import { enqueueEdu } from '#engine/server/delivery.ts';
import { fanoutDeviceChange } from '#engine/server/device-federation.ts';

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
          await fanoutDeviceChange(
            conn,
            subject,
            Number(row.stream_id),
            String(row.payload),
          );
        }
        await advance(conn, source, Number(rows[rows.length - 1].pos));
      });
    }
    // Intents are not a lossy change-log instruction. Keep tenant admission
    // occupied until the server's durable completion, even after projection.
    const prefix = 'tenant:' + tenant + ':to-device:';
    for (;;) {
      const intents = await db.query(
        'SELECT source_id,destination,payload FROM to_device_intents WHERE projected=0 ORDER BY rowid LIMIT 500',
      );
      if (!intents.length) break;
      await server.tx(async (conn) => {
        for (const intent of intents) {
          await enqueueEdu(
            conn,
            prefix + intent.source_id,
            String(intent.destination),
            'm.direct_to_device',
            JSON.parse(String(intent.payload)),
          );
        }
      });
      // This mark follows the durable server commit. Interruption replays the
      // same sources idempotently, without releasing tenant admission early.
      await db.tx(async (conn) => {
        for (const intent of intents) {
          await conn.execute(
            'UPDATE to_device_intents SET projected=1 WHERE source_id=?',
            [intent.source_id],
          );
        }
      });
    }
    // The prefix ends in ':', whose immediate successor is ';'. This indexed
    // range visits only this tenant's completed work, not its retained backlog.
    const end = prefix.slice(0, -1) + ';';
    for (;;) {
      const completed = await server.query(
        "SELECT source,destination FROM edu_outbox WHERE state='sent' AND source>=? AND source<? AND edu_type='m.direct_to_device' LIMIT 500",
        [prefix, end],
      );
      if (!completed.length) break;
      // Tenant deletion precedes server pruning. A crash between them leaves
      // harmless sent markers, never a chance to resurrect an accepted send.
      await db.tx(async (conn) => {
        for (const row of completed) {
          await conn.execute(
            'DELETE FROM to_device_intents WHERE source_id=?',
            [
              String(row.source).slice(prefix.length),
            ],
          );
        }
      });
      await server.tx(async (conn) => {
        for (const row of completed) {
          await conn.execute(
            "DELETE FROM edu_outbox WHERE source=? AND destination=? AND state='sent'",
            [row.source, row.destination],
          );
        }
      });
    }
  });
}
