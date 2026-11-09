import type { Store } from '#engine/store/index.ts';

let project: ((store: Store, tenant: string) => Promise<void>) | undefined;
export function setTenantProjector(fn: typeof project): void {
  project = fn;
}
export async function tenantCommitted(
  store: Store,
  tenant: string,
): Promise<void> {
  try {
    await project?.(store, tenant);
  } catch (error) {
    console.error('tenant projection pending for ' + tenant + ':', error);
  }
}
