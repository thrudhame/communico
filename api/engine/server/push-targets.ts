// Tenant lifecycle is authoritative. Server targets are a durable projection;
// rejection intent is committed before tenant deletion and replayed on startup.
import type { Store } from '#engine/store/index.ts';
import { advance, get } from '#engine/store/watermark.ts';
import { deleteRejectedPusher } from '#engine/tenant/pushers.ts';
import { localpartOf } from '#engine/ids.ts';
import { gatewayUrl } from '#engine/push/registration.ts';

/** Called under the existing projection lock; never nests file transactions. */
export async function projectPushTargets(
  store: Store,
  tenant: string,
): Promise<void> {
  const server = await store.server(), db = await store.tenant(tenant);
  for (;;) {
    const rejected = await server.query(
      'SELECT * FROM push_rejections WHERE tenant=? LIMIT 500',
      [tenant],
    );
    if (!rejected.length) break;
    await db.tx(async (tx) => {
      for (const row of rejected) {
        await deleteRejectedPusher(
          tx,
          localpartOf(String(row.user)),
          String(row.app_id),
          String(row.pushkey),
          String(row.incarnation),
        );
      }
    });
    await server.tx(async (tx) => {
      for (const row of rejected) {
        await tx.execute('DELETE FROM push_targets WHERE incarnation=?', [
          row.incarnation,
        ]);
        await tx.execute('DELETE FROM push_rejections WHERE incarnation=?', [
          row.incarnation,
        ]);
      }
    });
  }
  const source = 'tenant:' + tenant + ':pushers';
  for (;;) {
    const mark = await get(server, source);
    const rows = await db.query(
      'SELECT * FROM pusher_changes WHERE pos>? ORDER BY pos LIMIT 500',
      [mark],
    );
    if (!rows.length) break;
    await server.tx(async (tx) => {
      for (const row of rows) {
        const user = '@' + row.localpart + ':' + tenant;
        if (row.payload === null) {
          await tx.execute('DELETE FROM push_targets WHERE incarnation=?', [
            row.incarnation,
          ]);
          continue;
        }
        const payload = JSON.parse(String(row.payload));
        let state = 'active';
        try {
          if (payload.kind !== 'http') throw new Error();
          gatewayUrl(payload.data?.url);
          if (
            payload.data.format !== undefined &&
            payload.data.format !== 'event_id_only'
          ) throw new Error();
        } catch {
          state = 'unsupported';
        }
        const cut = Number(
          (await tx.query(
            'SELECT COALESCE(MAX(seq),0) AS m FROM notifications',
          ))[0].m,
        );
        await tx.execute(
          'INSERT INTO push_targets(tenant,user,app_id,pushkey,incarnation,payload,registered_seq,state) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tenant,user,app_id,pushkey) DO UPDATE SET incarnation=excluded.incarnation,payload=excluded.payload,registered_seq=excluded.registered_seq,state=excluded.state',
          [
            tenant,
            user,
            row.app_id,
            row.pushkey,
            row.incarnation,
            row.payload,
            cut,
            state,
          ],
        );
      }
      await advance(tx, source, Number(rows.at(-1)!.pos));
    });
  }
}
