// File-local semantic-write fence, shared by the server and tenant owners.
import type { Conn } from '#engine/store/db.ts';
import { canonicalJson } from '#engine/canonical.ts';
import {
  importPublicKeyFromRaw,
  matrixBase64,
} from '#engine/signing-primitives.js';
import type { RegisterOperation, RegisterSource } from './registers.ts';
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

/** Home's signed retention attestation, authenticated by the enrolled link
 * adapter. The envelope is current authority; the enclosed dot is not rewritten
 * into current authorship. Only this exact operation receives that authority. */
export type DomainHistory = DomainBinding & {
  kind: 'domain-history';
  operation: RegisterOperation;
};

/** A transaction-local import permit can only be constructed from an actual
 * home signature. The key comes from the adapter's authenticated current grant,
 * never from the history payload. Keep its signed material immutable. */
export class DomainHistoryProof {
  private constructor(private readonly encoded: string) {}

  static async verify(view: DomainHistory, signature: string, homeKey: string) {
    const encoded = canonicalJson(view);
    if (
      view.source !== 'home' || !await crypto.subtle.verify(
        'Ed25519',
        await importPublicKeyFromRaw(matrixBase64(homeKey, 32)),
        matrixBase64(signature, 64),
        new TextEncoder().encode(encoded),
      )
    ) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'invalid historical domain signature',
      );
    }
    return new DomainHistoryProof(encoded);
  }

  async require(conn: Conn, operation: RegisterOperation, localpart: string) {
    const view: DomainHistory = JSON.parse(this.encoded);
    if (
      view.localpart !== localpart ||
      canonicalJson(view.operation) !== canonicalJson(operation)
    ) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'historical domain fact differs',
      );
    }
    await requireDomainControl(conn, view);
  }
}

/** Ordinary authorship must be current; home can attest an exact retained fact.
 * Context is dependency, never authorship authority: register owners retain a
 * missing predecessor as pending until its authentic same-stream fact arrives.
 * Rejecting historical context here would deadlock before bootstrap supplies it. */
export async function requireDomainSources(
  conn: Conn,
  operation: RegisterOperation,
  current: RegisterSource[],
  localpart: string,
  history?: DomainHistoryProof,
) {
  const allowed = (dot: RegisterSource) =>
    current.some((source) =>
      source.source === dot.source && source.incarnation === dot.incarnation
    );
  if (history) {
    if (!(history instanceof DomainHistoryProof)) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'historical domain fact differs',
      );
    }
    await history.require(conn, operation, localpart);
    return;
  }
  if (!allowed(operation) || !Array.isArray(operation.context)) {
    throw new Error('domain source unavailable');
  }
}

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
