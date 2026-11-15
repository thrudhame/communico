// A signed complete home baseline is distinct from three independently drained
// key suffixes. It retains original facts, never claimable pools or copied cuts.
import { canonicalJson } from '#engine/canonical.ts';
import {
  type DomainBinding,
  requireDomainControl,
} from '#engine/facade/domain-control.ts';
import { LinkError } from '#engine/facade/protocol.ts';
import {
  importPublicKeyFromRaw,
  matrixBase64,
} from '#engine/signing-primitives.js';
import type { Conn } from '#engine/store/db.ts';
import {
  captureDeviceOperations,
  type DeviceOperation,
} from './device-source.ts';
import {
  captureSigningOperations,
  type SigningOperation,
} from './signing-operations.ts';
import {
  captureSignatureOperations,
  type SignatureOperation,
} from './signature-operations.ts';
import { type AuthorityFact, tenantAuthority } from './session-authority.ts';
import { MatrixError } from '#engine/matrix-error.ts';

export const KEY_BOOTSTRAP_SQL = `
CREATE TABLE key_bootstrap_publications(localpart TEXT PRIMARY KEY NOT NULL,pairing TEXT NOT NULL,grant_revision INTEGER NOT NULL,owner_revision INTEGER NOT NULL,source TEXT NOT NULL,incarnation TEXT NOT NULL,sequence INTEGER NOT NULL,hash TEXT NOT NULL,declaration_json TEXT NOT NULL);
`;
export const DEVICE_CREATION_HISTORY_SQL = `
CREATE TABLE device_creation_history(id TEXT PRIMARY KEY NOT NULL,payload_json TEXT NOT NULL);
`;
export type KeyOperation =
  | DeviceOperation
  | SigningOperation
  | SignatureOperation;
export type KeyKind =
  | 'device-operation'
  | 'signing-operation'
  | 'signature-operation';
export type KeyFact = { operationId: string; payloadHash: string };
export type KeyManifest = Record<KeyKind, KeyFact[]>;
export type KeyBootstrap = DomainBinding & {
  kind: 'key-bootstrap';
  manifest: KeyManifest;
};
export type KeyHistory = DomainBinding & {
  kind: 'key-history';
  keyKind: KeyKind;
  operation: KeyOperation;
  creation?: AuthorityFact;
};

/** Passive evidence has the original authority identity but never enters the
 * executable registry. Only an exact home-attested device operation uses it. */
function deviceCreation(
  raw: unknown,
  operation: DeviceOperation,
): AuthorityFact {
  const creation = raw as AuthorityFact | undefined;
  if (!creation || !Number.isSafeInteger(creation.seq) || creation.seq < 1) {
    throw new LinkError(
      'LINK_IDENTITY_MISMATCH',
      'invalid historical device creation',
    );
  }
  const expected: AuthorityFact = {
    id: canonicalJson([operation.source, operation.incarnation, creation.seq]),
    node: operation.source,
    incarnation: operation.incarnation,
    seq: creation.seq,
    localpart: operation.localpart,
    kind: 'device',
    deviceId: operation.deviceId,
  };
  if (
    expected.id !== operation.deviceIncarnation ||
    canonicalJson(expected) !== canonicalJson(raw)
  ) {
    throw new LinkError(
      'LINK_IDENTITY_MISMATCH',
      'historical device creation differs',
    );
  }
  return expected;
}

async function retainedCreation(conn: Conn, operation: DeviceOperation) {
  const rows = await conn.query(
    "SELECT payload AS payload_json FROM authority_facts WHERE id=? AND kind='device' UNION ALL SELECT payload_json FROM device_creation_history WHERE id=?",
    [operation.deviceIncarnation, operation.deviceIncarnation],
  );
  if (!rows.length) {
    throw new LinkError(
      'LINK_UNAVAILABLE',
      'key history awaits original device creation',
      503,
    );
  }
  const creation = deviceCreation(
    JSON.parse(String(rows[0].payload_json)),
    operation,
  );
  for (const row of rows) {
    if (
      canonicalJson(JSON.parse(String(row.payload_json))) !==
        canonicalJson(creation)
    ) {
      throw new LinkError('LINK_DIVERGED', 'retained device creation changed');
    }
  }
  return creation;
}

/** The enrolled home attests exact retained historical material. Current envelope
 * authority never rewrites an original dot or makes its old incarnation current. */
export class KeyHistoryProof {
  private constructor(private readonly encoded: string) {}

  static async verify(view: KeyHistory, signature: string, homeKey: string) {
    const encoded = canonicalJson(view);
    if (
      view.source !== 'home' ||
      !await crypto.subtle.verify(
        'Ed25519',
        await importPublicKeyFromRaw(matrixBase64(homeKey, 32)),
        matrixBase64(signature, 64),
        new TextEncoder().encode(encoded),
      )
    ) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'invalid historical key signature',
      );
    }
    return new KeyHistoryProof(encoded);
  }

  async require(conn: Conn, kind: KeyKind, operation: KeyOperation) {
    const view: KeyHistory = JSON.parse(this.encoded);
    if (
      view.keyKind !== kind || view.localpart !== operation.localpart ||
      canonicalJson(view.operation) !== canonicalJson(operation)
    ) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'historical key fact differs',
      );
    }
    await requireDomainControl(conn, view);
  }

  async retainCreation(conn: Conn, operation: DeviceOperation) {
    await this.require(conn, 'device-operation', operation);
    const view: KeyHistory = JSON.parse(this.encoded);
    const creation = deviceCreation(view.creation, operation);
    const encoded = canonicalJson(creation);
    const rows = await conn.query(
      'SELECT payload AS payload_json FROM authority_facts WHERE id=? UNION ALL SELECT payload_json FROM device_creation_history WHERE id=?',
      [creation.id, creation.id],
    );
    if (rows.some((row) => String(row.payload_json) !== encoded)) {
      throw new LinkError('LINK_DIVERGED', 'retained device creation changed');
    }
    await conn.execute(
      'INSERT INTO device_creation_history VALUES(?,?) ON CONFLICT(id) DO NOTHING',
      [creation.id, encoded],
    );
    return creation;
  }
}

function unique<T extends KeyOperation>(operations: T[]): T[] {
  const result = new Map<string, T>();
  for (const operation of operations) {
    const old = result.get(operation.operationId);
    if (old && canonicalJson(old) !== canonicalJson(operation)) {
      throw new LinkError('LINK_DIVERGED', 'retained key operation changed');
    }
    result.set(operation.operationId, operation);
  }
  return [...result.values()].sort((a, b) =>
    a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0
  );
}

/** One tenant transaction pins all histories after ordinary capture. Imported
 * facts and prior incarnations remain history; repeated scans allocate nothing. */
export async function captureKeyHistory(conn: Conn, localpart: string) {
  await captureDeviceOperations(conn, localpart);
  await captureSigningOperations(conn, localpart);
  await captureSignatureOperations(conn, localpart);
  const devices = (await conn.query(
    "SELECT json_extract(payload,'$.operation') AS payload_json FROM e2ee_changes WHERE localpart=? AND json_type(payload,'$.operation')='object' UNION ALL SELECT payload_json FROM device_operations WHERE localpart=?",
    [localpart, localpart],
  )).map((row) => JSON.parse(String(row.payload_json)) as DeviceOperation);
  const retained = async <T extends KeyOperation>(table: string) =>
    unique(
      (await conn.query(
        'SELECT payload_json FROM ' + table + ' WHERE localpart=?',
        [localpart],
      )).map((row) => JSON.parse(String(row.payload_json)) as T),
    );
  const deviceOperations = unique(devices);
  const creations = new Map<string, AuthorityFact>();
  for (const operation of deviceOperations) {
    creations.set(
      operation.deviceIncarnation,
      await retainedCreation(conn, operation),
    );
  }
  return {
    creations,
    'device-operation': deviceOperations,
    'signing-operation': await retained<SigningOperation>('signing_operations'),
    'signature-operation': await retained<SignatureOperation>(
      'signature_operations',
    ),
  };
}

export async function retainKeyBootstrap(
  conn: Conn,
  view: KeyBootstrap,
  sequence: number,
  hash: string,
) {
  for (const [kind, facts] of Object.entries(view.manifest)) {
    for (const fact of facts) {
      const rows = kind === 'device-operation'
        ? await conn.query(
          "SELECT json_extract(payload,'$.operation') AS payload_json FROM e2ee_changes WHERE localpart=? AND json_extract(payload,'$.operation.operationId')=? UNION ALL SELECT payload_json FROM device_operations WHERE localpart=? AND operation_id=?",
          [view.localpart, fact.operationId, view.localpart, fact.operationId],
        )
        : await conn.query(
          'SELECT payload_json FROM ' + (kind === 'signing-operation'
            ? 'signing_operations'
            : 'signature_operations') +
            ' WHERE localpart=? AND operation_id=?',
          [view.localpart, fact.operationId],
        );
      if (!rows.length) {
        throw new LinkError(
          'LINK_UNAVAILABLE',
          'bootstrap awaits retained key facts',
          503,
        );
      }
      for (const row of rows) {
        const operation = JSON.parse(String(row.payload_json)) as KeyOperation;
        if (
          operation.payloadHash !== fact.payloadHash ||
          operation.localpart !== view.localpart
        ) {
          throw new LinkError('LINK_DIVERGED', 'bootstrap key fact changed');
        }
      }
    }
  }
  const [old] = await conn.query(
    'SELECT * FROM key_bootstrap_publications WHERE localpart=?',
    [view.localpart],
  );
  const sameStream = old?.pairing === view.pairing &&
    old?.incarnation === view.incarnation;
  if (sameStream && Number(old.sequence) >= sequence) {
    if (Number(old.sequence) === sequence && old.hash !== hash) {
      throw new LinkError('LINK_DIVERGED', 'bootstrap declaration changed');
    }
    return;
  }
  await conn.execute(
    'INSERT INTO key_bootstrap_publications VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(localpart) DO UPDATE SET pairing=excluded.pairing,grant_revision=excluded.grant_revision,owner_revision=excluded.owner_revision,source=excluded.source,incarnation=excluded.incarnation,sequence=excluded.sequence,hash=excluded.hash,declaration_json=excluded.declaration_json',
    [
      view.localpart,
      view.pairing,
      view.grantRevision,
      view.ownerRevision,
      view.source,
      view.incarnation,
      sequence,
      hash,
      canonicalJson(view),
    ],
  );
}

/** Public readers may replace F1 evidence only after authenticated completeness.
 * Internal signature/dependency validation deliberately does not call this gate. */
export async function semanticKeyReader(
  conn: Conn,
  localpart: string,
): Promise<boolean> {
  const [selected] = await conn.query(
    'SELECT pairing,grant_revision FROM account_auth_snapshots WHERE localpart=?',
    [localpart],
  );
  const authority = await tenantAuthority(conn);
  if (!selected) {
    if (!authority || authority.node === 'home') return false;
    // An F1-only public view remains usable, but neither tenant-wide activation
    // nor losing the auth-selection row makes retained F2 material complete.
    const published = await conn.query(
      'SELECT 1 FROM account_auth_publications WHERE localpart=? UNION ALL SELECT 1 FROM key_bootstrap_publications WHERE localpart=? LIMIT 1',
      [localpart, localpart],
    );
    const evidence = await conn.query(
      'SELECT 1 FROM public_user_replicas WHERE localpart=?',
      [localpart],
    );
    if (!published.length && evidence.length) return false;
    throw new MatrixError(503, 'M_UNAVAILABLE', 'key bootstrap unavailable');
  }
  if (authority?.node === 'home') return true;
  const [row] = await conn.query(
    'SELECT declaration_json FROM key_bootstrap_publications WHERE localpart=? AND pairing=? AND grant_revision=?',
    [localpart, selected.pairing, selected.grant_revision],
  );
  if (!authority || !row) {
    throw new MatrixError(503, 'M_UNAVAILABLE', 'key bootstrap unavailable');
  }
  const view: KeyBootstrap = JSON.parse(String(row.declaration_json));
  if (
    view.source !== 'home' || view.incarnation !== authority.homeIncarnation
  ) throw new MatrixError(503, 'M_UNAVAILABLE', 'key bootstrap unavailable');
  try {
    await requireDomainControl(conn, view);
  } catch (error) {
    if (!(error instanceof LinkError)) throw error;
    throw new MatrixError(503, 'M_UNAVAILABLE', 'key bootstrap unavailable');
  }
  return true;
}
