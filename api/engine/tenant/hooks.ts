import type { Store } from '#engine/store/index.ts';
import type { Conn, Database } from '#engine/store/db.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';

// Durable truth is in the tenant transaction. This store-scoped index is only
// a discovery hint, rebuilt by open/startup, so idle scans never open a tenant.
type Revision = { pending: number; completed: number };
const revisions = new WeakMap<Store, Map<string, Revision>>();
function revision(store: Store, tenant: string): Revision {
  let tenants = revisions.get(store);
  if (!tenants) revisions.set(store, tenants = new Map());
  let value = tenants.get(tenant);
  if (!value) tenants.set(tenant, value = { pending: 0, completed: 0 });
  return value;
}

/** Called inside the same transaction as a projection-relevant mutation. */
export async function recordTenantProjection(conn: Conn): Promise<number> {
  const value = await nextCounter(conn, 'projection_revision');
  await conn.execute(
    "INSERT INTO counters(name,value) VALUES('projection_pending',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
    [value],
  );
  return value;
}

export async function pendingTenantProjection(db: Database): Promise<number> {
  const rows = await db.query(
    "SELECT value FROM counters WHERE name='projection_pending'",
  );
  return rows.length ? Number(rows[0].value) : 0;
}

/** Publish only committed revisions, before the optional post-commit hook. */
export function rememberTenantProjection(
  store: Store,
  tenant: string,
  pending: number,
): void {
  const value = revision(store, tenant);
  value.pending = Math.max(value.pending, pending);
}

export function tenantProjectionPending(store: Store, tenant: string): boolean {
  const value = revisions.get(store)?.get(tenant);
  return value !== undefined && value.pending > value.completed;
}

/** Acknowledge only the revision captured before a successful projection.
 * Newer commits keep both their durable marker and their discovery hint. */
export async function completeTenantProjection(
  store: Store,
  tenant: string,
  db: Database,
  captured: number,
): Promise<void> {
  if (!captured) return;
  await db.execute(
    "DELETE FROM counters WHERE name='projection_pending' AND value=?",
    [captured],
  );
  const value = revision(store, tenant);
  value.completed = Math.max(value.completed, captured);
}

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
