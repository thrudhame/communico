import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';

const listeners = new Set<(store: Store, tenant: string) => void>();
export function onTenantStream(
  fn: (store: Store, tenant: string) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function tenantStreamCommitted(store: Store, tenant: string): void {
  for (const fn of listeners) fn(store, tenant);
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
