// Erasure intent belongs to the tenant, not the append-only event stores.
import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { splitId } from '#engine/ids.ts';
import type { ErasureCut } from '#engine/room/state.ts';

export async function markErased(
  conn: Conn,
  localpart: string,
  cuts: Record<string, ErasureCut>,
): Promise<void> {
  // A retry never advances the original erasure boundary.
  await conn.execute(
    'INSERT INTO erased_users(localpart,room_cuts) VALUES(?,?) ON CONFLICT(localpart) DO NOTHING',
    [localpart, JSON.stringify(cuts)],
  );
}

export async function erasureRow(
  conn: Conn,
  localpart: string,
  roomId: string,
): Promise<ErasureCut | null | false> {
  const rows = await conn.query(
    'SELECT room_cuts FROM erased_users WHERE localpart=?',
    [localpart],
  );
  if (rows.length === 0) return false;
  const cuts = JSON.parse(String(rows[0].room_cuts)) as Record<
    string,
    ErasureCut
  >;
  return cuts[roomId] ?? null;
}

export async function erasureFor(
  store: Store,
  sender: string,
  roomId: string,
  tenant?: Tenant,
): Promise<ErasureCut | null | false> {
  const parts = splitId(sender);
  if (parts.server === null) return false;
  if (tenant?.serverName === parts.server) {
    return tenant.tx((tx) => tx.erasure.get(parts.localpart, roomId));
  }
  // Remote requests never create a tenant or learn a peer's erasure intent.
  if (!(await store.tenants()).includes(parts.server)) return false;
  const db = await store.tenant(parts.server);
  return db.tx((conn) => erasureRow(conn, parts.localpart, roomId));
}
