// Home-signed first-ingress ownership policy. Per-file activation is durable;
// the journal apply ACK follows BOTH files, never merely a received policy.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  importPublicKeyFromRaw,
  matrixBase64,
} from '#engine/signing-primitives.js';
import type { Conn, Database } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import type { NodeIdentity } from './identity.ts';
import { appendRecord, type Journal } from './journal.ts';
import type { Grant, Pairings, Signed } from './pairing.ts';
import {
  integer,
  LINK_SUPPORTED,
  LinkError,
  negotiate,
  object,
  OWNER_CONTROL_CAPABILITY,
  type Stream,
  text,
} from './protocol.ts';

type PublicationIdentity = {
  node: string;
  incarnation: string;
  domain: string;
};
export type OwnerControl = {
  kind: 'owner-control';
  server: string;
  pairing: string;
  revision: number;
  grantRevision: number;
  policy: 'first-ingress';
  collision: 'home-wins';
  nodes: {
    node: string;
    incarnation: string;
    lane: { offset: number; stride: number };
  }[];
  required: { type: string; version: number }[];
};

function hash(raw: unknown): string {
  return createHash('sha256').update(canonicalJson(raw)).digest('hex');
}
function unavailable(): never {
  throw new MatrixError(503, 'M_UNAVAILABLE', 'ownership control unavailable');
}
function mismatch(message: string): never {
  throw new LinkError('LINK_IDENTITY_MISMATCH', message, 403);
}

/** One boot-independent publication domain. Call only from node composition,
 * never infer the local node from an imported record. Restore fencing is separate. */
export async function publicationIdentity(
  db: Database,
  node: string,
): Promise<PublicationIdentity> {
  text(node);
  const candidate = {
    node,
    incarnation: crypto.randomUUID(),
    domain: crypto.randomUUID(),
  };
  return await db.tx(async (conn) => {
    const [held] = await conn.query(
      'SELECT node,incarnation,domain FROM publication_domain WHERE singleton=1',
    );
    if (held) {
      if (held.node !== node) {
        mismatch('publication domain belongs to another node');
      }
      return {
        node,
        incarnation: String(held.incarnation),
        domain: String(held.domain),
      };
    }
    await conn.execute(
      'INSERT INTO publication_domain(singleton,node,incarnation,domain) VALUES(1,?,?,?)',
      [node, candidate.incarnation, candidate.domain],
    );
    return candidate;
  });
}

function controlOf(raw: unknown): OwnerControl {
  const row = object(raw);
  if (
    row.kind !== 'owner-control' || row.policy !== 'first-ingress' ||
    row.collision !== 'home-wins'
  ) {
    throw new LinkError('LINK_BAD_RECORD', 'unsupported ownership policy', 400);
  }
  if (!Array.isArray(row.nodes) || row.nodes.length !== 2) {
    throw new LinkError(
      'LINK_BAD_RECORD',
      'F2 requires home and one facade',
      400,
    );
  }
  const server = text(row.server);
  const required = negotiate(
    { protocol: { major: 1, minor: 0 }, server, required: row.required },
    server,
    LINK_SUPPORTED,
  ).required;
  if (
    !required.some((item) =>
      item.type === OWNER_CONTROL_CAPABILITY.type && item.version === 1
    )
  ) {
    throw new LinkError(
      'LINK_CAPABILITY_MISMATCH',
      'ownership reader must be required',
    );
  }
  const nodes = row.nodes.map((raw, index) => {
    const node = object(raw);
    const lane = object(node.lane);
    if (
      integer(lane.offset, 1) !== index + 1 || integer(lane.stride, 1) !== 2
    ) {
      throw new LinkError(
        'LINK_BAD_RECORD',
        'invalid disjoint device-stream lane',
        400,
      );
    }
    return {
      node: text(node.node),
      incarnation: text(node.incarnation),
      lane: { offset: index + 1, stride: 2 },
    };
  });
  if (nodes[0].node !== 'home' || nodes[1].node === 'home') {
    mismatch('invalid ownership nodes');
  }
  return {
    kind: 'owner-control',
    server,
    pairing: text(row.pairing),
    revision: integer(row.revision, 1),
    grantRevision: integer(row.grantRevision, 1),
    policy: 'first-ingress',
    collision: 'home-wins',
    nodes,
    required,
  };
}

async function install(
  conn: Conn,
  signed: Signed<OwnerControl>,
): Promise<void> {
  const body = signed.body;
  const digest = hash(body);
  const [current] = await conn.query(
    'SELECT revision,body_hash FROM facade_owner_activation WHERE pairing=?',
    [body.pairing],
  );
  if (
    current &&
    (Number(current.revision) > body.revision ||
      (Number(current.revision) === body.revision &&
        current.body_hash !== digest))
  ) {
    throw new LinkError(
      'LINK_DIVERGED',
      'ownership control regressed or changed',
    );
  }
  const [held] = await conn.query(
    'SELECT body_hash FROM facade_owner_controls WHERE pairing=? AND revision=?',
    [body.pairing, body.revision],
  );
  if (held && held.body_hash !== digest) {
    throw new LinkError('LINK_DIVERGED', 'ownership revision collision');
  }
  if (current?.body_hash === digest) return;
  await conn.execute(
    'INSERT INTO facade_owner_controls(pairing,revision,body_hash,signed_json) VALUES(?,?,?,?) ON CONFLICT(pairing,revision) DO NOTHING',
    [body.pairing, body.revision, digest, canonicalJson(signed)],
  );
  await conn.execute(
    'INSERT INTO facade_owner_activation(pairing,revision,body_hash) VALUES(?,?,?) ON CONFLICT(pairing) DO UPDATE SET revision=excluded.revision,body_hash=excluded.body_hash',
    [body.pairing, body.revision, digest],
  );
}

/** Export only from a completed home pairing. Existing F1 enrollments remain
 * valid: an old destination refuses this typed page without receiving/ACKing it. */
export async function exportOwnerControl(
  store: Store,
  tenant: Tenant,
  pairings: Pairings,
  pairing: string,
) {
  const connection = await pairings.connection(pairing);
  if (connection.state !== 'paired' || !connection.grant) {
    mismatch('ownership export requires paired home');
  }
  const grant = connection.grant;
  const transcript = grant.body.transcript.body;
  const server = await store.server();
  const identity = await publicationIdentity(server, 'home');
  const body: OwnerControl = {
    kind: 'owner-control',
    server: tenant.serverName,
    pairing,
    revision: 1,
    grantRevision: grant.body.revision,
    policy: 'first-ingress',
    collision: 'home-wins',
    nodes: [
      {
        node: 'home',
        incarnation: identity.incarnation,
        lane: { offset: 1, stride: 2 },
      },
      {
        node: connection.context.node,
        incarnation: transcript.incarnation,
        lane: { offset: 2, stride: 2 },
      },
    ],
    required: [OWNER_CONTROL_CAPABILITY],
  };
  const signed = {
    body,
    signature: await tenant.signer().sign(canonicalJson(body)),
  };
  // Recheck binding in the source transaction after asynchronous preparation.
  const record = await server.tx(async (conn) => {
    await assertGrant(conn, grant, 'home');
    await install(conn, signed);
    return await appendRecord(conn, connection.context.node, {
      source: 'home',
      incarnation: pairing,
      stream: 'owner-control',
      type: 'owner-control',
      version: 1,
      operationId: `owner-control:${pairing}:1`,
      payload: signed,
    });
  });
  await (await store.tenant(tenant.serverName)).tx((conn) =>
    install(conn, signed)
  );
  return record;
}

async function assertGrant(conn: Conn, grant: Grant, side: string) {
  const id = grant.body.transcript.body.context.id;
  const [binding] = await conn.query(
    'SELECT state,grant_json FROM facade_pairings WHERE id=? AND side=?',
    [id, side],
  );
  if (
    binding?.state !== 'paired' || binding.grant_json !== canonicalJson(grant)
  ) mismatch('ownership grant changed');
}

export class OwnerControls {
  constructor(
    private readonly server: Database,
    private readonly tenant: Database,
    private readonly pairings: Pairings,
    private readonly node: Pick<
      NodeIdentity,
      'server' | 'node' | 'incarnation'
    >,
  ) {}

  private async verified(
    raw: unknown,
    grant: Grant,
  ): Promise<Signed<OwnerControl>> {
    const signed = object(raw);
    const body = controlOf(signed.body);
    const context = grant.body.transcript.body.context;
    // Do not verify a normalized subset while retaining a different wire object.
    if (canonicalJson(body) !== canonicalJson(signed.body)) {
      mismatch('noncanonical ownership body');
    }
    const signature = text(signed.signature);
    let valid = false;
    try {
      valid = await crypto.subtle.verify(
        'Ed25519',
        await importPublicKeyFromRaw(matrixBase64(context.home.publicKey, 32)),
        matrixBase64(signature, 64),
        new TextEncoder().encode(canonicalJson(body)),
      );
    } catch { /* A malformed signature grants no authority. */ }
    if (!valid) mismatch('invalid home ownership signature');
    if (
      body.server !== context.server || body.server !== this.node.server ||
      body.pairing !== context.id ||
      body.grantRevision !== grant.body.revision ||
      body.nodes[1].node !== this.node.node ||
      body.nodes[1].incarnation !== this.node.incarnation
    ) {
      mismatch('ownership control differs from enrolled node incarnation');
    }
    return { body, signature };
  }

  async apply(journal: Journal, stream: Stream): Promise<boolean> {
    const record = await journal.next('home', stream);
    if (!record) return false;
    if (
      record.type !== 'owner-control' || record.version !== 1 ||
      stream.stream !== 'owner-control'
    ) {
      throw new LinkError('LINK_CAPABILITY_MISMATCH', 'not ownership control');
    }
    const grant = await this.pairings.active();
    const signed = await this.verified(record.payload, grant);
    if (
      record.source !== 'home' || record.incarnation !== signed.body.pairing
    ) mismatch('wrong ownership source');
    await this.server.tx(async (conn) => {
      await assertGrant(conn, grant, 'facade');
      await install(conn, signed);
    });
    await this.tenant.tx((conn) => install(conn, signed));
    // Authority revalidation and the apply ACK share the journal transaction.
    // A separate check followed by complete() would reopen a revocation race.
    return await journal.apply('home', stream, async (conn, current) => {
      await assertGrant(conn, grant, 'facade');
      if (current.hash !== record.hash) {
        throw new LinkError('LINK_DIVERGED', 'ownership apply cut changed');
      }
      return { revision: signed.body.revision, hash: hash(signed.body) };
    });
  }

  async ready(): Promise<OwnerControl> {
    const grant = await this.pairings.active();
    const pairing = grant.body.transcript.body.context.id;
    const rows = await Promise.all(
      [this.server, this.tenant].map((db) =>
        db.query(
          'SELECT a.revision,a.body_hash,c.signed_json FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision WHERE a.pairing=?',
          [pairing],
        )
      ),
    );
    const left = rows[0][0], right = rows[1][0];
    if (
      !left || !right || left.revision !== right.revision ||
      left.body_hash !== right.body_hash ||
      left.signed_json !== right.signed_json
    ) unavailable();
    const signed = await this.verified(
      JSON.parse(String(left.signed_json)),
      grant,
    );
    if (hash(signed.body) !== left.body_hash) unavailable();
    await this.server.tx((conn) => assertGrant(conn, grant, 'facade'));
    return signed.body;
  }
}
