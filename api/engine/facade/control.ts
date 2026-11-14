// Home approves public authority; the facade can extend validity, not the roster.
// Control effects and their journal result share the server transaction. Signing
// and signature verification happen outside that transaction.
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import { type KeyDoc, signWithSigner } from '#engine/federation/keys.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Signer } from '#engine/room/signer.ts';
import {
  b64encodeStd,
  importPublicKeyFromRaw,
  matrixBase64,
} from '#engine/signing-primitives.js';
import type { Conn, Database } from '#engine/store/db.ts';
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
type Control = { kind: 'key-roster'; body: Roster; signature: string };

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
): Promise<LinkRecord> {
  const db = await store.server();
  for (;;) {
    const roster = await homePublicKeys(db, {
      server: tenant.serverName,
      keyId: tenant.keyId,
      publicKey: tenant.publicB64,
    });
    const body: Roster = {
      server: tenant.serverName,
      revision: roster.revision,
      keys: [{
        keyId: tenant.keyId,
        publicKey: tenant.publicB64,
        retiredAt: null,
      }, ...roster.keys]
        .sort((a, b) => a.keyId < b.keyId ? -1 : a.keyId > b.keyId ? 1 : 0),
    };
    const payload: Control = {
      kind: 'key-roster',
      body,
      signature: await tenant.signer().sign(canonicalJson(body)),
    };
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
        version: 1,
        operationId: `roster:${pairing}:${body.revision}`,
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

  async contact(now = Date.now()): Promise<void> {
    integer(now);
    await this.db.tx(async (conn) => {
      await conn.execute(
        'UPDATE facade_key_roster SET last_home_ms=MAX(COALESCE(last_home_ms,0),?) WHERE singleton=1',
        [now],
      );
    });
  }

  async status() {
    const [held] = await this.db.query(
      'SELECT revision,roster_json,last_home_ms FROM facade_key_roster WHERE singleton=1',
    );
    const roster = held.roster_json === null
      ? null
      : rosterOf(JSON.parse(String(held.roster_json)));
    const own = roster?.keys.find((key) => key.keyId === this.signer.keyId);
    return {
      revision: Number(held.revision),
      ready: own?.publicKey === this.publicKey && own?.retiredAt === null,
      lastHome: held.last_home_ms === null ? null : Number(held.last_home_ms),
    };
  }

  async apply(journal: Journal, stream: Stream): Promise<boolean> {
    const record = await journal.next('home', stream);
    if (!record) return false;
    if (
      record.type !== 'control' || record.version !== 1 ||
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
    return await journal.apply('home', stream, async (conn, current) => {
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
      if (Number(held.revision) !== body.revision) {
        await conn.execute(
          'UPDATE facade_key_roster SET revision=?,roster_json=?,document_json=NULL,issued_ms=NULL WHERE singleton=1',
          [body.revision, encoded],
        );
      }
      return { revision: body.revision };
    });
  }

  async document(now = Date.now()): Promise<KeyDoc> {
    integer(now);
    const grant = await this.pairings.active();
    const binding = grant.body.transcript.body.context.id;
    const requireGrant = async (conn: Conn) => {
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
    };
    for (;;) {
      const held = await this.db.tx(async (conn) => {
        await requireGrant(conn);
        return (await conn.query(
          'SELECT * FROM facade_key_roster WHERE singleton=1',
        ))[0];
      });
      if (held.roster_json === null) {
        throw new MatrixError(503, 'M_UNAVAILABLE', 'key roster not ready');
      }
      const roster = rosterOf(JSON.parse(String(held.roster_json)));
      const own = roster.keys.find((key) => key.keyId === this.signer.keyId);
      if (own?.publicKey !== this.publicKey || own.retiredAt !== null) {
        throw new MatrixError(
          503,
          'M_UNAVAILABLE',
          'facade signing key is not approved',
        );
      }
      const max = config().facade.maxofflinedays;
      const capped = max > 0 &&
        (held.last_home_ms === null ||
          now - Number(held.last_home_ms) >= max * 86400000);
      const cached = held.document_json === null
        ? null
        : JSON.parse(String(held.document_json)) as KeyDoc;
      if (
        cached && now < cached.valid_until_ts &&
        (capped || now < (Number(held.issued_ms) + cached.valid_until_ts) / 2)
      ) return cached;
      if (capped) {
        throw new MatrixError(
          503,
          'M_UNAVAILABLE',
          'offline signing validity expired',
        );
      }
      const doc: KeyDoc = {
        server_name: roster.server,
        verify_keys: {},
        old_verify_keys: {},
        valid_until_ts: now +
          Math.min(config().federation.keyvalidityhours, 168) * 3600000,
        signatures: {},
      };
      for (const key of roster.keys) {
        if (key.retiredAt === null) {
          doc.verify_keys[key.keyId] = { key: key.publicKey };
        } else {
          doc.old_verify_keys![key.keyId] = {
            key: key.publicKey,
            expired_ts: key.retiredAt,
          };
        }
      }
      await signWithSigner(
        doc as unknown as Record<string, unknown>,
        this.signer,
      );
      const saved = await this.db.tx(async (conn) => {
        await requireGrant(conn);
        const [current] = await conn.query(
          'SELECT roster_json,last_home_ms,document_json FROM facade_key_roster WHERE singleton=1',
        );
        if (
          current.roster_json !== held.roster_json ||
          current.last_home_ms !== held.last_home_ms ||
          current.document_json !== held.document_json
        ) return false;
        await conn.execute(
          'UPDATE facade_key_roster SET document_json=?,issued_ms=? WHERE singleton=1',
          [canonicalJson(doc), now],
        );
        return true;
      });
      if (saved) return doc;
    }
  }
}
