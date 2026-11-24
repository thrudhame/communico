// Erasure intent belongs to the tenant, not the append-only event stores.
import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { splitId } from '#engine/ids.ts';
import type { ErasureCut } from '#engine/room/state.ts';
import { openRoom } from '#engine/room/index.ts';

/** Exact intent facts across hosted domains, not a count or a feed position.
 * The caller must check stable() after the reads it intends to certify. */
export async function captureErasureInputs(store: Store, viewerDomain: string) {
  const directory = store.tenantDirectoryCut();
  if (directory === undefined) return;
  const domains = [...new Set([viewerDomain, ...await store.tenants()])].sort();
  const databases = await Promise.all(domains.map((id) => store.tenant(id)));
  const revision = await store.revisionProbe('tenants', domains);
  const cuts = domains.map(revision);
  if (cuts.some((cut) => cut === undefined)) return;
  const stable = () =>
    store.tenantDirectoryCut() === directory &&
    domains.every((id, i) => revision(id) === cuts[i]);
  const facts = await Promise.all(
    databases.map((db) =>
      db.query(
        'SELECT localpart,room_cuts FROM erased_users ORDER BY localpart',
      )
    ),
  );
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify([domains, facts])),
    ),
  ).toHex();
  if (stable()) return { hash, stable };
}

export async function captureErasureCuts(
  store: Store,
): Promise<Record<string, ErasureCut>> {
  const cuts: Record<string, ErasureCut> = {};
  for (const id of await store.rooms()) {
    const room = await openRoom(store, id);
    cuts[id] = await room.tx((tx) => tx.state.erasureCut());
  }
  return cuts;
}

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
