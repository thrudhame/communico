import type { Conn } from '#engine/store/db.ts';
import {
  type DomainHistoryProof,
  requireDomainSources,
} from '#engine/facade/domain-control.ts';
import type { RegisterOperation } from '#engine/facade/registers.ts';
import { tenantAuthority } from './session-authority.ts';

export async function requireTenantDomainSource(
  conn: Conn,
  operation: RegisterOperation,
  localpart: string,
  history?: DomainHistoryProof,
) {
  const authority = await tenantAuthority(conn);
  if (!authority) throw new Error('domain source unavailable');
  await requireDomainSources(
    conn,
    operation,
    [
      { source: 'home', incarnation: authority.homeIncarnation },
      { source: authority.edgeNode, incarnation: authority.edgeIncarnation },
    ],
    localpart,
    history,
  );
  return authority;
}
