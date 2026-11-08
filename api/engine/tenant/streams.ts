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
