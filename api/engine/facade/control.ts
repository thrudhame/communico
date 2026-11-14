// Home publishes complete co-signed authority. Facades serve it unchanged.
// Control effects and their journal result share the server transaction. Signing
// and signature verification happen outside that transaction.
import { canonicalJson } from '#engine/canonical.ts';
import { createHash } from 'node:crypto';
import { config } from '#engine/config.ts';
import {
  type KeyDoc,
  type KeyStore,
  keyStore,
  signWithSigner,
} from '#engine/federation/keys.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { federationPolicy } from '#engine/federation/policy.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { keyDocument } from '#engine/federation/key-document.ts';
import type { Signer } from '#engine/room/signer.ts';
import {
  b64encodeStd,
  importPublicKeyFromRaw,
  matrixBase64,
  verifyJson,
} from '#engine/signing-primitives.js';
import type { Database } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { appendRecord, type Journal } from './journal.ts';
import { homePublicKeys, type Pairings } from './pairing.ts';
import {
  integer,
  LinkError,
  type LinkRecord,
  object,
  type Stream,
  text,
} from './protocol.ts';

type Roster = {
  server: string;
  revision: number;
  keys: { keyId: string; publicKey: string; retiredAt: number | null }[];
};
type Control = {
  kind: 'key-roster';
  body: Roster;
  signature: string;
  document?: KeyDoc;
};

export type CollectKeySignature = (
  keyId: string,
  document: KeyDoc,
) => Promise<string>;

async function signatureValid(doc: KeyDoc, id: string, publicKey: string) {
  try {
    return await verifyJson(
      doc,
      doc.server_name,
      id,
      await importPublicKeyFromRaw(matrixBase64(publicKey, 32)),
    );
  } catch {
    return false;
  }
}

/** A complete document is the shared publication contract, not an endpoint's
 * interpretation of how many self-signatures a receiver happens to accept. */
async function completeDocument(raw: unknown, roster: Roster): Promise<KeyDoc> {
  const doc = keyDocument(raw);
  const active: KeyDoc['verify_keys'] = {};
  const retired: NonNullable<KeyDoc['old_verify_keys']> = {};
  for (const key of roster.keys) {
    if (key.retiredAt === null) active[key.keyId] = { key: key.publicKey };
    else retired[key.keyId] = { key: key.publicKey, expired_ts: key.retiredAt };
  }
  if (
    doc.server_name !== roster.server ||
    canonicalJson(doc.verify_keys) !== canonicalJson(active) ||
    canonicalJson(doc.old_verify_keys ?? {}) !== canonicalJson(retired)
  ) {
    throw new LinkError(
      'LINK_IDENTITY_MISMATCH',
      'document differs from approved roster',
      403,
    );
  }
  for (const [id, key] of Object.entries(active)) {
    if (!await signatureValid(doc, id, key.key)) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'missing or invalid key document signature',
        403,
      );
    }
  }
  return doc;
}

async function homeRoster(
  db: Database,
  signer: Signer,
  publicKey: string,
): Promise<Roster> {
  const roster = await homePublicKeys(db, {
    server: signer.serverName,
    keyId: signer.keyId,
    publicKey,
  });
  return {
    server: signer.serverName,
    revision: roster.revision,
    keys: [{ keyId: signer.keyId, publicKey, retiredAt: null }, ...roster.keys]
      .sort((a, b) => a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0),
  };
}

/** Only this owner can create/refresh a publication. Network and crypto are
 * outside transactions; a changed home control cut discards the entire candidate.
 * Failed collection leaves the prior complete publication intact. */
export async function publishKeyDocument(
  db: Database,
  signer: Signer,
  publicKey: string,
  collect: CollectKeySignature,
  now = Date.now(),
): Promise<KeyDoc> {
  integer(now);
  for (;;) {
    const roster = await homeRoster(db, signer, publicKey);
    const encoded = canonicalJson(roster);
    const [held] = await db.query(
      'SELECT * FROM facade_key_roster WHERE singleton=1',
    );
    const days = config().facade.maxofflinedays;
    const horizon = days > 0 ? days * 86400000 : null;
    const cadence = (await federationPolicy(db)).keyvalidityhours * 3600000 / 2;
    const cached = held.document_json === null
      ? null
      : JSON.parse(String(held.document_json)) as KeyDoc;
    if (
      held.roster_json === encoded && cached && held.issued_ms !== null &&
      cached.valid_until_ts ===
        (horizon === null
          ? Number.MAX_SAFE_INTEGER
          : Number(held.issued_ms) + horizon) &&
      now <
        Number(held.issued_ms) +
          Math.min(cadence, horizon === null ? Infinity : horizon / 2)
    ) {
      return await completeDocument(cached, roster);
    }
    const doc: KeyDoc = {
      server_name: signer.serverName,
      verify_keys: {},
      old_verify_keys: {},
      valid_until_ts: horizon === null
        ? Number.MAX_SAFE_INTEGER
        : now + horizon,
      signatures: {},
    };
    integer(doc.valid_until_ts);
    for (const key of roster.keys) {
      if (key.retiredAt === null) {
        doc.verify_keys[key.keyId] = { key: key.publicKey };
      } else {doc.old_verify_keys![key.keyId] = {
          key: key.publicKey,
          expired_ts: key.retiredAt,
        };}
    }
    await signWithSigner(doc as unknown as Record<string, unknown>, signer);
    for (const key of roster.keys) {
      if (key.retiredAt === null && key.keyId !== signer.keyId) {
        // A collector cannot mutate the shared candidate or other signatures.
        doc.signatures[signer.serverName][key.keyId] = await collect(
          key.keyId,
          structuredClone(doc),
        );
      }
    }
    await completeDocument(doc, roster);
    const saved = await writeRoster(db, () =>
      db.tx(async (conn) => {
        const [control] = await conn.query(
          'SELECT revision FROM facade_control WHERE singleton=1',
        );
        const [current] = await conn.query(
          'SELECT roster_json,document_json FROM facade_key_roster WHERE singleton=1',
        );
        if (
          Number(control.revision) !== roster.revision ||
          current.roster_json !== held.roster_json ||
          current.document_json !== held.document_json
        ) return false;
        await conn.execute(
          'UPDATE facade_key_roster SET revision=?,roster_json=?,document_json=?,issued_ms=? WHERE singleton=1',
          [roster.revision, encoded, canonicalJson(doc), now],
        );
        return true;
      }));
    if (saved) return doc;
  }
}

/** A public read never starts network collection or publishes a partial roster. */
export async function publishedKeyDocument(
  db: Database,
  signer: Signer,
  publicKey: string,
): Promise<KeyDoc | null> {
  const roster = await homeRoster(db, signer, publicKey);
  if (roster.keys.length === 1) return null;
  if (
    roster.keys.every((key) =>
      key.keyId === signer.keyId || key.retiredAt !== null
    )
  ) {
    return await publishKeyDocument(db, signer, publicKey, () => {
      throw new LinkError('LINK_UNAVAILABLE', 'unexpected active facade');
    });
  }
  const [held] = await db.query(
    'SELECT roster_json,document_json FROM facade_key_roster WHERE singleton=1',
  );
  if (
    held.roster_json !== canonicalJson(roster) || held.document_json === null
  ) {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      'co-signed key document not ready',
    );
  }
  const doc = await completeDocument(
    JSON.parse(String(held.document_json)),
    roster,
  );
  if (Date.now() >= doc.valid_until_ts) {
    throw new MatrixError(503, 'M_UNAVAILABLE', 'key document expired');
  }
  return doc;
}

// HTTP, notices and control workers share one row even when their FacadeKeys
// instances differ. Queue its mutations at the file owner rather than making
// authenticated link progress compete for the store's bounded conflict retries.
const rosterWriters = new Map<string, Promise<void>>();

async function writeRoster<T>(
  db: Database,
  write: () => Promise<T>,
): Promise<T> {
  const previous = rosterWriters.get(db.path) ?? Promise.resolve();
  const run = previous.then(write);
  const settled = run.then(() => undefined, () => undefined);
  rosterWriters.set(db.path, settled);
  try {
    return await run;
  } finally {
    if (rosterWriters.get(db.path) === settled) rosterWriters.delete(db.path);
  }
}

// A retained roster belongs to a home control cut, not merely this node's key.
// Re-enrollment must not revive authority from an older grant at any consumer.
function rosterAt(
  held: Record<string, unknown>,
  revision: number,
): Roster | null {
  return held.roster_json === null || Number(held.revision) < revision
    ? null
    : rosterOf(JSON.parse(String(held.roster_json)));
}

function rosterOf(raw: unknown): Roster {
  const value = object(raw);
  if (!Array.isArray(value.keys)) {
    throw new LinkError('LINK_BAD_RECORD', 'missing key roster', 400);
  }
  const ids = new Set<string>();
  const keys = value.keys.map((raw) => {
    const key = object(raw);
    const keyId = text(key.keyId);
    if (!/^ed25519:[A-Za-z0-9_]+$/.test(keyId) || ids.has(keyId)) {
      throw new LinkError(
        'LINK_BAD_RECORD',
        'invalid or duplicate roster key',
        400,
      );
    }
    ids.add(keyId);
    const publicKey = b64encodeStd(matrixBase64(text(key.publicKey), 32));
    return {
      keyId,
      publicKey,
      retiredAt: key.retiredAt === null ? null : integer(key.retiredAt),
    };
  });
  return {
    server: text(value.server),
    revision: integer(value.revision, 1),
    keys,
  };
}

/** A control change racing signature preparation is retried at the new cut.
 * One immutable operation per revision is retained for each pairing stream. */
export async function exportKeyRoster(
  store: Store,
  tenant: Tenant,
  peer: string,
  pairing: string,
  collect?: CollectKeySignature,
  now = Date.now(),
): Promise<LinkRecord> {
  const db = await store.server();
  for (;;) {
    const document = await publishKeyDocument(
      db,
      tenant.signer(),
      tenant.publicB64,
      collect ?? (() => {
        throw new MatrixError(
          503,
          'M_UNAVAILABLE',
          'facade signature collector unavailable',
        );
      }),
      now,
    );
    const body = await homeRoster(db, tenant.signer(), tenant.publicB64);
    await completeDocument(document, body);
    const payload: Control = {
      kind: 'key-roster',
      body,
      signature: await tenant.signer().sign(canonicalJson(body)),
      document,
    };
    const digest = createHash('sha256').update(canonicalJson(document)).digest(
      'hex',
    );
    const record = await db.tx(async (conn) => {
      const [control] = await conn.query(
        'SELECT revision FROM facade_control WHERE singleton=1',
      );
      if (Number(control.revision) !== body.revision) return null;
      const [binding] = await conn.query(
        "SELECT node,state FROM facade_pairings WHERE id=? AND side='home'",
        [pairing],
      );
      if (!binding || binding.node !== peer || binding.state !== 'paired') {
        throw new LinkError(
          'LINK_UNPAIRED',
          'key export requires active pairing',
          403,
        );
      }
      return await appendRecord(conn, peer, {
        source: 'home',
        incarnation: pairing,
        stream: 'control',
        type: 'control',
        version: 2,
        operationId: `key-document:${pairing}:${body.revision}:${digest}`,
        payload,
      });
    });
    if (record) return record;
  }
}

export class FacadeKeys {
  constructor(
    private readonly db: Database,
    private readonly signer: Signer,
    private readonly publicKey: string,
    private readonly pairings: Pairings,
  ) {}

  /** Bootstrap signatures do not depend on a previously published document.
   * Only the enrolled home can request them, and its own signature authenticates
   * the exact server, public-key maps and validity being approved. */
  async cosign(raw: unknown): Promise<string> {
    const grant = await this.pairings.active();
    const home = grant.body.transcript.body.context.home;
    const doc = keyDocument(raw);
    if (
      doc.server_name !== this.signer.serverName ||
      doc.verify_keys[home.keyId]?.key !== home.publicKey ||
      doc.verify_keys[this.signer.keyId]?.key !== this.publicKey ||
      doc.valid_until_ts <= Date.now() ||
      !await signatureValid(doc, home.keyId, home.publicKey)
    ) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'key document lacks enrolled home authority',
        403,
      );
    }
    const copy = structuredClone(doc);
    await signWithSigner(
      copy as unknown as Record<string, unknown>,
      this.signer,
    );
    // Recheck the durable grant after asynchronous verification/signing.
    if (canonicalJson(await this.pairings.active()) !== canonicalJson(grant)) {
      throw new LinkError('LINK_UNPAIRED', 'key signing grant changed', 403);
    }
    return copy.signatures[this.signer.serverName][this.signer.keyId];
  }

  requestSigner(): Signer {
    return {
      serverName: this.signer.serverName,
      keyId: this.signer.keyId,
      sign: async (canonical) => {
        await this.document();
        return await this.signer.sign(canonical);
      },
    };
  }

  /** Local signatures use the home-approved roster, never a dial to the logical
   * server (which may resolve back here). Remote keys retain ordinary acquisition.
   * This feeds the shared event verifier and request authentication unchanged. */
  verificationKeys(): KeyStore {
    const remote = keyStore(this.db, { signer: this.requestSigner() });
    return {
      ...remote,
      getVerifyKey: async (name, keyId, floor, purpose, context) => {
        if (name !== this.signer.serverName) {
          return await remote.getVerifyKey(
            name,
            keyId,
            floor,
            purpose,
            context,
          );
        }
        const grant = await this.pairings.active();
        const [held] = await this.db.query(
          'SELECT revision,roster_json,document_json FROM facade_key_roster WHERE singleton=1',
        );
        const roster = rosterAt(held, grant.body.revision);
        const key = roster?.keys.find((key) => key.keyId === keyId);
        let document: KeyDoc | null = null;
        if (roster && held.document_json !== null) {
          try {
            document = await completeDocument(
              JSON.parse(String(held.document_json)),
              roster,
            );
          } catch {
            /* An older partial publication confers no key authority. */
          }
        }
        if (
          !roster || roster.server !== name ||
          !key || !document || floor > document.valid_until_ts ||
          (key.retiredAt !== null &&
            (purpose === 'request' || floor > key.retiredAt))
        ) {
          throw new UpstreamError('validation', {
            phase: 'key-lookup',
            reason: 'local key unavailable for required purpose and validity',
          });
        }
        return await importPublicKeyFromRaw(matrixBase64(key.publicKey, 32));
      },
    };
  }

  async contact(now = Date.now()): Promise<void> {
    integer(now);
    await writeRoster(this.db, () =>
      this.db.tx(async (conn) => {
        await conn.execute(
          'UPDATE facade_key_roster SET last_home_ms=MAX(COALESCE(last_home_ms,0),?) WHERE singleton=1',
          [now],
        );
      }));
  }

  async status() {
    const [held] = await this.db.query(
      'SELECT revision,roster_json,last_home_ms FROM facade_key_roster WHERE singleton=1',
    );
    let roster: Roster | null = null;
    try {
      roster = rosterAt(held, (await this.pairings.active()).body.revision);
    } catch (error) {
      if (!(error instanceof LinkError) || error.code !== 'LINK_UNPAIRED') {
        throw error;
      }
    }
    let ready = false;
    if (roster) {
      try {
        await this.document();
        ready = true;
      } catch (error) {
        if (!(error instanceof MatrixError) && !(error instanceof LinkError)) {
          throw error;
        }
      }
    }
    return {
      revision: Number(held.revision),
      ready,
      lastHome: held.last_home_ms === null ? null : Number(held.last_home_ms),
    };
  }

  async apply(journal: Journal, stream: Stream): Promise<boolean> {
    const record = await journal.next('home', stream);
    if (!record) return false;
    if (
      record.type !== 'control' || ![1, 2].includes(record.version) ||
      stream.stream !== 'control'
    ) {
      throw new LinkError('LINK_CAPABILITY_MISMATCH', 'not a control roster');
    }
    const grant = await this.pairings.active();
    const context = grant.body.transcript.body.context;
    if (record.source !== 'home' || record.incarnation !== context.id) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'wrong control source',
        403,
      );
    }
    const raw = object(record.payload);
    if (raw.kind !== 'key-roster') {
      throw new LinkError('LINK_BAD_RECORD', 'unknown control operation', 400);
    }
    const body = rosterOf(raw.body);
    try {
      const key = await importPublicKeyFromRaw(
        matrixBase64(context.home.publicKey, 32),
      );
      if (
        !await crypto.subtle.verify(
          'Ed25519',
          key,
          matrixBase64(text(raw.signature), 64),
          new TextEncoder().encode(canonicalJson(body)),
        )
      ) {
        throw new Error('signature mismatch');
      }
    } catch {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'invalid home roster signature',
        403,
      );
    }
    const home = body.keys.find((key) => key.keyId === context.home.keyId);
    if (
      body.server !== context.server ||
      body.server !== this.signer.serverName ||
      body.revision < grant.body.revision ||
      home?.publicKey !== context.home.publicKey || home.retiredAt !== null
    ) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'roster does not match home authority',
        403,
      );
    }
    const encoded = canonicalJson(body);
    const document = record.version === 2
      ? await completeDocument(raw.document, body)
      : null;
    return await writeRoster(
      this.db,
      () =>
        journal.apply('home', stream, async (conn, current) => {
          if (current.hash !== record.hash) {
            throw new LinkError('LINK_DIVERGED', 'control apply raced');
          }
          const [binding] = await conn.query(
            "SELECT state,revision FROM facade_pairings WHERE id=? AND side='facade'",
            [context.id],
          );
          if (
            binding?.state !== 'paired' ||
            Number(binding.revision) !== grant.body.revision
          ) {
            throw new LinkError('LINK_UNPAIRED', 'control grant changed', 403);
          }
          const [held] = await conn.query(
            'SELECT revision,roster_json FROM facade_key_roster WHERE singleton=1',
          );
          if (
            Number(held.revision) > body.revision ||
            (Number(held.revision) === body.revision &&
              held.roster_json !== encoded)
          ) {
            throw new LinkError(
              'LINK_DIVERGED',
              'regressing or changed control revision',
            );
          }
          if (document || Number(held.revision) !== body.revision) {
            await conn.execute(
              'UPDATE facade_key_roster SET revision=?,roster_json=?,document_json=?,issued_ms=NULL WHERE singleton=1',
              [
                body.revision,
                encoded,
                document ? canonicalJson(document) : null,
              ],
            );
          }
          return { revision: body.revision };
        }),
    );
  }

  async document(now = Date.now()): Promise<KeyDoc> {
    integer(now);
    const grant = await this.pairings.active();
    const binding = grant.body.transcript.body.context.id;
    const held = await this.db.tx(async (conn) => {
      const [current] = await conn.query(
        "SELECT state,revision FROM facade_pairings WHERE id=? AND side='facade'",
        [binding],
      );
      if (
        current?.state !== 'paired' ||
        Number(current.revision) !== grant.body.revision
      ) {
        throw new MatrixError(
          503,
          'M_UNAVAILABLE',
          'facade grant is no longer active',
        );
      }
      return (await conn.query(
        'SELECT * FROM facade_key_roster WHERE singleton=1',
      ))[0];
    });
    const roster = rosterAt(held, grant.body.revision);
    if (roster === null || held.document_json === null) {
      throw new MatrixError(503, 'M_UNAVAILABLE', 'key roster not ready');
    }
    const own = roster.keys.find((key) => key.keyId === this.signer.keyId);
    if (own?.publicKey !== this.publicKey || own.retiredAt !== null) {
      throw new MatrixError(
        503,
        'M_UNAVAILABLE',
        'facade signing key is not approved',
      );
    }
    let doc: KeyDoc;
    try {
      doc = await completeDocument(
        JSON.parse(String(held.document_json)),
        roster,
      );
    } catch {
      throw new MatrixError(
        503,
        'M_UNAVAILABLE',
        'co-signed key document not ready',
      );
    }
    if (now >= doc.valid_until_ts) {
      throw new MatrixError(
        503,
        'M_UNAVAILABLE',
        'offline signing validity expired',
      );
    }
    return doc;
  }
}
