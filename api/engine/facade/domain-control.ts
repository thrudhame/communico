// File-local semantic-write fence, shared by the server and tenant owners.
import type { Conn } from '#engine/store/db.ts';
import type { OwnerControl } from './ownership.ts';
import { LinkError } from './protocol.ts';

export type DomainBinding = {
  server: string;
  pairing: string;
  grantRevision: number;
  ownerRevision: number;
  localpart: string;
  source: string;
  incarnation: string;
};

/** Check in the SAME file transaction as the semantic mutation. */
export async function requireDomainControl(conn: Conn, view: DomainBinding) {
  const [row] = await conn.query(
    'SELECT a.revision,c.signed_json FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision WHERE a.pairing=?',
    [view.pairing],
  );
  if (!row || Number(row.revision) < view.ownerRevision) {
    throw new LinkError(
      'LINK_UNAVAILABLE',
      'domain operation awaits ownership control',
      503,
    );
  }
  const control: OwnerControl = JSON.parse(String(row.signed_json)).body;
  if (
    control.server !== view.server ||
    control.grantRevision !== view.grantRevision ||
    !control.nodes.some((node) =>
      node.node === view.source && node.incarnation === view.incarnation
    )
  ) {
    throw new LinkError(
      'LINK_IDENTITY_MISMATCH',
      'domain operation differs from active control',
      403,
    );
  }
}
