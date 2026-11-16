import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';

// Replica publication wakes local readers/lifecycle work, but is not new local
// authoring. Source exporters must not turn these hints into freshness records.
export type TenantChangeSource = 'local' | 'replica';
const listeners = new Set<
  (store: Store, tenant: string, source: TenantChangeSource) => void
>();
export function onTenantStream(
  fn: (store: Store, tenant: string, source: TenantChangeSource) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function tenantStreamCommitted(
  store: Store,
  tenant: string,
  source: TenantChangeSource = 'local',
): void {
  for (const fn of listeners) fn(store, tenant, source);
}

// Read allocated maxima, not retained rows or a single device's last change.
// Deletion/acknowledgment does not move these durable stream ceilings backward.
export async function syncStreamHeads(conn: Conn) {
  const counters = new Map(
    (await conn.query('SELECT name,value FROM counters')).map((
      row,
    ) => [String(row.name), Number(row.value)]),
  );
  return {
    accountData: counters.get('account_data') ?? 0,
    inbox: counters.get('to_device') ?? 0,
    keyPools: counters.get('key_pools') ?? 0,
  };
}
