// Enrollment is explicit local administration plus a home-initiated handshake.
// All network/crypto preparation is outside retryable store transactions. The
// registry retains the secret's digest, never the enrollment credential itself.
import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import type { Signer } from '#engine/room/signer.ts';
import type { Conn, Database } from '#engine/store/db.ts';
import {
  b64encodeStd,
  importPublicKeyFromRaw,
  matrixBase64,
} from '#engine/signing-primitives.js';
import { nodeId, type NodeIdentity } from './identity.ts';
import {
  type Capability,
  integer,
  LINK_CAPABILITIES,
  LINK_VERSION,
  LinkError,
  negotiate,
  object,
  text,
  type Version,
} from './protocol.ts';

type PublicKey = { keyId: string; publicKey: string };
export type PairingContext = {
  id: string;
  server: string;
  node: string;
  url: string;
  home: PublicKey;
  homePin: string;
  facadePin: string;
  expires: number;
  protocol: Version;
  required: Capability[];
  secretHash: string;
};
export type PairingBundle = Omit<PairingContext, 'secretHash'> & {
  secret: string;
};
export type Signed<T> = { body: T; signature: string };
export type Transcript = Signed<{
  kind: 'facade-enrollment-transcript';
  context: PairingContext;
  incarnation: string;
  key: PublicKey;
  challenge: string;
}>;
export type Grant = Signed<{
  kind: 'facade-enrollment-grant';
  transcript: Transcript;
  revision: number;
}>;
export type Receipt = Signed<{
  kind: 'facade-enrollment-receipt';
  pairing: string;
  grantHash: string;
}>;
export type Revocation = Signed<{
  kind: 'facade-enrollment-revocation';
  server: string;
  node: string;
  pairing: string;
  revision: number;
}>;
type Entry = {
  id: string;
  side: string;
  node: string;
  state: string;
  context: PairingContext;
  transcript: Transcript | null;
  grant: Grant | null;
  receipt: Receipt | null;
  revocation: Revocation | null;
  revision: number;
};

function refused(message: string, status = 403): never {
  throw new LinkError('LINK_ENROLLMENT_REFUSED', message, status);
}
function collision(): never {
  throw new LinkError('LINK_DIVERGED', 'enrollment transcript collision');
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function equal(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function sameDigest(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function pinOf(value: unknown): string {
  const pin = text(value);
  if (!/^[a-f0-9]{64}$/.test(pin)) refused('invalid SPKI SHA-256 pin', 400);
  return pin;
}
function keyOf(value: unknown): PublicKey {
  const row = object(value);
  const keyId = text(row.keyId);
  if (!/^ed25519:[A-Za-z0-9_]+$/.test(keyId)) {
    refused('invalid signing key ID', 400);
  }
  const publicKey = text(row.publicKey);
  try {
    matrixBase64(publicKey, 32);
  } catch {
    refused('invalid public key', 400);
  }
  return { keyId, publicKey };
}
function contextOf(
  value: unknown,
  supported: readonly Capability[],
): PairingContext {
  const row = object(value);
  const server = text(row.server);
  const version = negotiate(row, server, supported);
  let url: URL;
  try {
    url = new URL(text(row.url));
  } catch {
    refused('pairing requires an HTTPS origin', 400);
  }
  if (
    url.protocol !== 'https:' || url.username || url.password || url.search ||
    url.hash || url.pathname !== '/'
  ) {
    refused('pairing requires an HTTPS origin', 400);
  }
  const secretHash = text(row.secretHash);
  if (!/^[a-f0-9]{64}$/.test(secretHash)) {
    refused('invalid credential digest', 400);
  }
  return {
    id: text(row.id),
    server,
    node: nodeId(row.node),
    url: url.origin,
    home: keyOf(row.home),
    homePin: pinOf(row.homePin),
    facadePin: pinOf(row.facadePin),
    expires: integer(row.expires, 1),
    protocol: version.protocol,
    required: version.required,
    secretHash,
  };
}
function signedOf<T>(raw: unknown, body: (value: unknown) => T): Signed<T> {
  const row = object(raw);
  const signature = text(row.signature);
  try {
    matrixBase64(signature, 64);
  } catch {
    refused('invalid enrollment signature');
  }
  return { body: body(row.body), signature };
}
function transcriptOf(
  raw: unknown,
  supported: readonly Capability[],
): Transcript {
  return signedOf(raw, (value) => {
    const row = object(value);
    if (row.kind !== 'facade-enrollment-transcript') {
      refused('wrong transcript kind', 400);
    }
    const challenge = text(row.challenge);
    try {
      matrixBase64(challenge, 32);
    } catch {
      refused('invalid challenge', 400);
    }
    return {
      kind: 'facade-enrollment-transcript',
      context: contextOf(row.context, supported),
      incarnation: text(row.incarnation),
      key: keyOf(row.key),
      challenge,
    };
  });
}
function grantOf(raw: unknown, supported: readonly Capability[]): Grant {
  return signedOf(raw, (value) => {
    const row = object(value);
    if (row.kind !== 'facade-enrollment-grant') {
      refused('wrong grant kind', 400);
    }
    return {
      kind: 'facade-enrollment-grant',
      transcript: transcriptOf(row.transcript, supported),
      revision: integer(row.revision, 1),
    };
  });
}
async function sign<T>(signer: Signer, body: T): Promise<Signed<T>> {
  return { body, signature: await signer.sign(canonicalJson(body)) };
}
async function verify<T>(value: Signed<T>, key: PublicKey): Promise<void> {
  const publicKey = await importPublicKeyFromRaw(
    matrixBase64(key.publicKey, 32),
  );
  if (
    !await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      matrixBase64(value.signature, 64),
      new TextEncoder().encode(canonicalJson(value.body)),
    )
  ) {
    refused('invalid enrollment signature');
  }
}
async function entry(conn: Pick<Conn, 'query'>, id: string): Promise<Entry> {
  const rows = await conn.query('SELECT * FROM facade_pairings WHERE id=?', [
    id,
  ]);
  if (rows.length !== 1) refused('unknown pairing', 401);
  const row = rows[0];
  const parsed = <T>(value: unknown): T | null =>
    value === null ? null : JSON.parse(String(value));
  return {
    id: String(row.id),
    side: String(row.side),
    node: String(row.node),
    state: String(row.state),
    context: JSON.parse(String(row.context_json)),
    revision: Number(row.revision),
    transcript: parsed<Transcript>(row.transcript_json),
    grant: parsed<Grant>(row.grant_json),
    receipt: parsed<Receipt>(row.receipt_json),
    revocation: parsed<Revocation>(row.revocation_json),
  };
}
function live(row: Entry, side: string, now?: number): void {
  if (row.side !== side) refused('wrong enrollment role');
  if (row.state === 'revoked') refused('pairing revoked');
  if (now !== undefined && row.context.expires <= now) {
    refused('pairing expired', 401);
  }
}
async function nextRevision(conn: Conn): Promise<number> {
  await conn.execute(
    'UPDATE facade_control SET revision=revision+1 WHERE singleton=1',
  );
  const [row] = await conn.query(
    'SELECT revision FROM facade_control WHERE singleton=1',
  );
  return integer(Number(row.revision), 1);
}

export class Pairings {
  private readonly key: PublicKey;
  constructor(
    private readonly db: Database,
    private readonly signer: Signer,
    publicKey: string,
    private readonly pin: string,
    private readonly node?: NodeIdentity,
    private readonly supported: readonly Capability[] = LINK_CAPABILITIES,
  ) {
    this.key = keyOf({ keyId: signer.keyId, publicKey });
    pinOf(pin);
  }

  async create(input: {
    node: string;
    url: string;
    facadePin: string;
    expires: number;
    required: Capability[];
  }, now = Date.now()): Promise<PairingBundle> {
    if (this.node) refused('facade cannot create home pairings');
    const secret = b64encodeStd(crypto.getRandomValues(new Uint8Array(32)));
    const context = contextOf({
      ...input,
      id: crypto.randomUUID(),
      server: this.signer.serverName,
      home: this.key,
      homePin: this.pin,
      protocol: LINK_VERSION,
      secretHash: hash(secret),
    }, this.supported);
    if (context.expires <= now) refused('pairing expired', 401);
    await this.db.tx(async (conn) => {
      const existing = await conn.query(
        "SELECT id FROM facade_pairings WHERE node=? AND state<>'revoked'",
        [context.node],
      );
      if (existing.length) refused('node already has a pairing', 409);
      await conn.execute(
        "INSERT INTO facade_pairings(id,side,node,state,context_json) VALUES(?,'home',?,'pending',?)",
        [context.id, context.node, canonicalJson(context)],
      );
    });
    const { secretHash: _, ...publicContext } = context;
    return { ...publicContext, secret };
  }

  async accept(raw: unknown, now = Date.now()): Promise<void> {
    if (!this.node) refused('home cannot accept facade enrollment');
    const row = object(raw);
    const secret = text(row.secret);
    const context = contextOf(
      { ...row, secretHash: hash(secret) },
      this.supported,
    );
    if (
      context.server !== this.node.server || context.node !== this.node.node ||
      !sameDigest(context.facadePin, this.pin)
    ) refused('pairing does not match this node');
    if (context.expires <= now) refused('pairing expired', 401);
    await this.db.tx(async (conn) => {
      const existing = await conn.query(
        'SELECT id,context_json,state FROM facade_pairings',
      );
      for (const old of existing) {
        const prior = JSON.parse(String(old.context_json)) as PairingContext;
        if (old.id === context.id) {
          if (!equal(prior, context)) collision();
          if (old.state === 'revoked') refused('pairing revoked');
          return;
        }
        if (
          !equal(prior.home, context.home) ||
          prior.homePin !== context.homePin || old.state !== 'revoked'
        ) {
          refused('facade is already bound to a home authority', 409);
        }
      }
      await conn.execute(
        "INSERT INTO facade_pairings(id,side,node,state,context_json) VALUES(?,'facade',?,'pending',?)",
        [context.id, context.node, canonicalJson(context)],
      );
    });
  }

  async challenge(
    id: string,
    secret: string,
    peerPin: string,
    now = Date.now(),
  ): Promise<Transcript> {
    if (!this.node) refused('home cannot issue facade challenge');
    const row = await entry(this.db, id);
    live(row, 'facade');
    if (
      !sameDigest(row.context.homePin, peerPin) ||
      !sameDigest(row.context.secretHash, hash(secret))
    ) {
      refused('wrong enrollment credential', 401);
    }
    live(row, 'facade', row.state === 'paired' ? undefined : now);
    if (row.transcript) return row.transcript;
    const transcript = await sign(this.signer, {
      kind: 'facade-enrollment-transcript' as const,
      context: row.context,
      incarnation: this.node.incarnation,
      key: this.key,
      challenge: b64encodeStd(crypto.getRandomValues(new Uint8Array(32))),
    });
    return await this.db.tx(async (conn) => {
      const current = await entry(conn, id);
      live(current, 'facade');
      if (current.transcript) return current.transcript;
      live(current, 'facade', now);
      await conn.execute(
        'UPDATE facade_pairings SET transcript_json=? WHERE id=?',
        [canonicalJson(transcript), id],
      );
      return transcript;
    });
  }

  async grant(id: string, raw: unknown, now = Date.now()): Promise<Grant> {
    if (this.node) refused('facade cannot grant home authority');
    const transcript = transcriptOf(raw, this.supported);
    const row = await entry(this.db, id);
    live(row, 'home');
    if (
      !equal(row.context, transcript.body.context) ||
      !equal(row.context.home, this.key)
    ) collision();
    await verify(transcript, transcript.body.key);
    const expectedPrefix = 'ed25519:' + row.node + '_';
    const expectedKeyId = expectedPrefix +
      createHash('sha256').update(
        matrixBase64(transcript.body.key.publicKey, 32),
      ).digest('hex');
    if (transcript.body.key.keyId !== expectedKeyId) {
      refused('facade key ID does not match node key');
    }
    const revision = await this.db.tx(async (conn) => {
      const current = await entry(conn, id);
      live(current, 'home');
      if (current.transcript && !equal(current.transcript, transcript)) {
        collision();
      }
      if (current.revision) return current.revision;
      live(current, 'home', now);
      const revision = await nextRevision(conn);
      await conn.execute(
        "UPDATE facade_pairings SET state='granting',transcript_json=?,revision=? WHERE id=?",
        [canonicalJson(transcript), revision, id],
      );
      return revision;
    });
    const grant = await sign(this.signer, {
      kind: 'facade-enrollment-grant' as const,
      transcript,
      revision,
    });
    return await this.db.tx(async (conn) => {
      const current = await entry(conn, id);
      live(current, 'home');
      if (current.grant) {
        if (!equal(current.grant, grant)) collision();
        return current.grant;
      }
      await conn.execute('UPDATE facade_pairings SET grant_json=? WHERE id=?', [
        canonicalJson(grant),
        id,
      ]);
      return grant;
    });
  }

  async complete(
    id: string,
    raw: unknown,
    peerPin: string,
    now = Date.now(),
  ): Promise<Receipt> {
    if (!this.node) refused('home cannot consume a facade grant');
    const grant = grantOf(raw, this.supported);
    const row = await entry(this.db, id);
    live(row, 'facade');
    if (!sameDigest(row.context.homePin, peerPin)) refused('wrong home pin');
    if (!row.transcript || !equal(row.transcript, grant.body.transcript)) {
      collision();
    }
    await verify(grant, row.context.home);
    if (
      !equal(grant.body.transcript.body.key, this.key) ||
      grant.body.transcript.body.incarnation !== this.node.incarnation
    ) {
      refused('grant is for another facade identity');
    }
    const receipt = await sign(this.signer, {
      kind: 'facade-enrollment-receipt' as const,
      pairing: id,
      grantHash: hash(grant),
    });
    return await this.db.tx(async (conn) => {
      const current = await entry(conn, id);
      live(current, 'facade');
      if (current.grant) {
        if (!equal(current.grant, grant) || !current.receipt) collision();
        return current.receipt;
      }
      live(current, 'facade', now);
      const [control] = await conn.query(
        'SELECT revision FROM facade_control WHERE singleton=1',
      );
      if (grant.body.revision <= Number(control.revision)) {
        refused('regressing control revision');
      }
      await conn.execute(
        'UPDATE facade_control SET revision=? WHERE singleton=1',
        [grant.body.revision],
      );
      await conn.execute(
        "UPDATE facade_pairings SET state='paired',grant_json=?,receipt_json=?,revision=? WHERE id=?",
        [canonicalJson(grant), canonicalJson(receipt), grant.body.revision, id],
      );
      return receipt;
    });
  }

  async confirm(id: string, raw: unknown): Promise<void> {
    if (this.node) refused('facade cannot confirm a home pairing');
    const receipt = signedOf(raw, (value) => {
      const body = object(value);
      if (body.kind !== 'facade-enrollment-receipt') {
        refused('wrong receipt kind');
      }
      return {
        kind: 'facade-enrollment-receipt' as const,
        pairing: text(body.pairing),
        grantHash: text(body.grantHash),
      };
    });
    const row = await entry(this.db, id);
    live(row, 'home');
    if (
      !row.grant || receipt.body.pairing !== id ||
      receipt.body.grantHash !== hash(row.grant)
    ) collision();
    await verify(receipt, row.grant.body.transcript.body.key);
    await this.db.tx(async (conn) => {
      const current = await entry(conn, id);
      live(current, 'home');
      if (current.receipt && !equal(current.receipt, receipt)) collision();
      await conn.execute(
        "UPDATE facade_pairings SET state='paired',receipt_json=? WHERE id=?",
        [canonicalJson(receipt), id],
      );
    });
  }

  async active(): Promise<Grant> {
    if (!this.node) refused('home has no facade authority');
    const rows = await this.db.query(
      "SELECT id FROM facade_pairings WHERE side='facade' AND state='paired'",
    );
    if (rows.length !== 1) {
      throw new LinkError('LINK_UNPAIRED', 'facade not enrolled', 503);
    }
    const row = await entry(this.db, String(rows[0].id));
    if (!row.grant || !row.receipt || !row.transcript) {
      refused('corrupt enrolled authority');
    }
    const grant = grantOf(row.grant, this.supported);
    if (
      !equal(grant.body.transcript, row.transcript) ||
      !equal(row.transcript.body.context, row.context) ||
      row.context.server !== this.node.server ||
      row.context.node !== this.node.node ||
      row.context.facadePin !== this.pin ||
      !equal(row.transcript.body.key, this.key) ||
      row.transcript.body.incarnation !== this.node.incarnation ||
      row.revision !== grant.body.revision
    ) {
      refused('enrolled authority does not match local identity');
    }
    await verify(row.transcript, this.key);
    await verify(grant, row.context.home);
    await verify(row.receipt, this.key);
    if (
      row.receipt.body.grantHash !== hash(grant) ||
      row.receipt.body.pairing !== row.id
    ) collision();
    return grant;
  }

  async revoke(id: string): Promise<Revocation> {
    if (this.node) refused('facade cannot revoke home authority');
    const reserved = await this.db.tx(async (conn) => {
      const current = await entry(conn, id);
      if (current.side !== 'home') refused('wrong enrollment role');
      if (current.state === 'revoked') return current;
      const revision = await nextRevision(conn);
      await conn.execute(
        "UPDATE facade_pairings SET state='revoked',revision=? WHERE id=?",
        [revision, id],
      );
      return { ...current, revision };
    });
    const revocation = await sign(this.signer, {
      kind: 'facade-enrollment-revocation' as const,
      server: this.signer.serverName,
      node: reserved.node,
      pairing: id,
      revision: reserved.revision,
    });
    await this.db.execute(
      'UPDATE facade_pairings SET revocation_json=? WHERE id=?',
      [canonicalJson(revocation), id],
    );
    return revocation;
  }

  async retire(raw: unknown, peerPin: string): Promise<void> {
    if (!this.node) refused('home cannot receive facade revocation');
    const revocation = signedOf(raw, (value) => {
      const row = object(value);
      if (row.kind !== 'facade-enrollment-revocation') {
        refused('wrong revocation kind');
      }
      return {
        kind: 'facade-enrollment-revocation' as const,
        server: text(row.server),
        node: nodeId(row.node),
        pairing: text(row.pairing),
        revision: integer(row.revision, 1),
      };
    });
    const row = await entry(this.db, revocation.body.pairing);
    if (
      row.side !== 'facade' || !sameDigest(row.context.homePin, peerPin) ||
      revocation.body.server !== this.node.server ||
      revocation.body.node !== this.node.node
    ) refused('wrong revocation authority');
    await verify(revocation, row.context.home);
    await this.db.tx(async (conn) => {
      const current = await entry(conn, row.id);
      if (current.revocation) {
        if (!equal(current.revocation, revocation)) collision();
        return;
      }
      const [control] = await conn.query(
        'SELECT revision FROM facade_control WHERE singleton=1',
      );
      if (revocation.body.revision <= Number(control.revision)) {
        refused('regressing control revision');
      }
      await conn.execute(
        'UPDATE facade_control SET revision=? WHERE singleton=1',
        [revocation.body.revision],
      );
      await conn.execute(
        "UPDATE facade_pairings SET state='revoked',revision=?,revocation_json=? WHERE id=?",
        [revocation.body.revision, canonicalJson(revocation), row.id],
      );
    });
  }

  async status(): Promise<
    { id: string; node: string; state: string; revision: number }[]
  > {
    return await pairingStatus(this.db);
  }

  /** TLS admission trusts only an authority explicitly accepted by local admin.
   * Retired bindings still admit their own signed revocation retry; each route
   * separately checks its required pending/active authority before mutation. */
  async allowsHome(peerPin: string): Promise<boolean> {
    if (!this.node) return false;
    const rows = await this.db.query(
      "SELECT context_json FROM facade_pairings WHERE side='facade'",
    );
    return rows.some((row) => {
      const context = contextOf(
        JSON.parse(String(row.context_json)),
        this.supported,
      );
      return context.server === this.node!.server &&
        context.node === this.node!.node &&
        sameDigest(context.facadePin, this.pin) &&
        sameDigest(context.homePin, peerPin);
    });
  }

  /** Narrow, credential-free home connection contract. The transport never
   * reads registry tables or chooses a peer from public request data. */
  async connection(id: string): Promise<{
    context: PairingContext;
    state: string;
    grant: Grant | null;
    transcript: Transcript | null;
  }> {
    if (this.node) refused('facade cannot initiate a link');
    const row = await entry(this.db, id);
    const context = contextOf(row.context, this.supported);
    if (
      row.side !== 'home' || !equal(context.home, this.key) ||
      !sameDigest(context.homePin, this.pin)
    ) {
      refused('link configuration does not match home authority');
    }
    return {
      context,
      state: row.state,
      grant: row.grant,
      transcript: row.transcript,
    };
  }
}

/** Registry inspection does not require any signing or TLS credential. */
export async function pairingStatus(db: Database): Promise<{
  id: string;
  node: string;
  state: string;
  revision: number;
}[]> {
  const rows = await db.query(
    'SELECT id,node,state,revision FROM facade_pairings ORDER BY id',
  );
  return rows.map((row) => ({
    id: String(row.id),
    node: String(row.node),
    state: String(row.state),
    revision: Number(row.revision),
  }));
}
