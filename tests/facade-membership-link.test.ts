import { assert, assertEquals, assertRejects } from '@std/assert';
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import {
  AccountSnapshots,
  exportAccountAuth,
} from '#engine/facade/accounts.ts';
import { enrolledTenant, initializeNode } from '#engine/facade/identity.ts';
import { Journal } from '#engine/facade/journal.ts';
import { MembershipOperations } from '#engine/facade/membership.ts';
import { exportOwnerControl, OwnerControls } from '#engine/facade/ownership.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { LINK_CAPABILITIES, LINK_SUPPORTED } from '#engine/facade/protocol.ts';
import { bindRole } from '#engine/facade/role.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import type {
  MembershipOperation,
  MembershipState,
} from '#engine/server/membership-operations.ts';
import {
  importPublicKeyFromRaw,
  matrixBase64,
} from '#engine/signing-primitives.js';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-membership-link-' });
  const open = (side: string) =>
    openStore({
      dir: dir + '/' + side,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema, tenant: tenantSchema } });
  const home = await open('home'), edge = await open('edge');
  await bindRole(home, { role: 'home', server: 'logical.test', node: '' });
  await bindRole(edge, {
    role: 'facade',
    server: 'logical.test',
    node: 'edge_a',
  });
  const ht = await openTenant(home, 'logical.test', { create: true });
  await ht.tx(async (tx) => {
    await tx.users.insert('alice', 'Alice');
    await tx.users.insert('bob', 'Bob');
  });
  const node = await initializeNode(
    await edge.server(),
    'logical.test',
    'edge_a',
  );
  const hp = new Pairings(
    await home.server(),
    ht.signer(),
    ht.publicB64,
    'a'.repeat(64),
  );
  const fp = new Pairings(
    await edge.server(),
    node.signer(),
    node.publicKey,
    'b'.repeat(64),
    node,
  );
  const bundle = await hp.create({
    node: 'edge_a',
    url: 'https://facade.test',
    facadePin: 'b'.repeat(64),
    expires: Date.now() + 60000,
    required: [...LINK_CAPABILITIES],
  });
  await fp.accept(bundle);
  await hp.confirm(
    bundle.id,
    await fp.complete(
      bundle.id,
      await hp.grant(
        bundle.id,
        await fp.challenge(bundle.id, bundle.secret, 'a'.repeat(64)),
      ),
      'a'.repeat(64),
    ),
  );
  const et = await enrolledTenant(edge, fp, 'logical.test', 'edge_a');
  const ej = new Journal(await edge.server(), LINK_SUPPORTED);
  const owners = new OwnerControls(
    await edge.server(),
    await edge.tenant('logical.test'),
    fp,
    node,
  );
  const control = await exportOwnerControl(home, ht, hp, bundle.id);
  await ej.receive('home', [control]);
  await owners.apply(ej, control);
  const auth = await exportAccountAuth(home, ht, hp, bundle.id, 'alice', false);
  await ej.receive('home', [auth]);
  await new AccountSnapshots(edge, et, fp, owners).apply(ej, auth);
  const es = new MembershipOperations(edge, et, fp, node);
  const hs = new MembershipOperations(home, ht, hp);
  return {
    home,
    edge,
    ht,
    et,
    node,
    hp,
    fp,
    bundle,
    es,
    hs,
    close: async () => {
      await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function source(
  f: Awaited<ReturnType<typeof fixture>>,
  sequence = 1,
  side: 'home' | 'edge' = 'edge',
) {
  const server = await f[side].server();
  const [row] = await server.query(
    'SELECT c.signed_json FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision',
  );
  const body = JSON.parse(String(row.signed_json)).body;
  const origin = body.nodes.find((n: { node: string }) =>
    n.node === (side === 'home' ? 'home' : f.node.node)
  );
  // This is the already-committed source-owner boundary. The real invite/knock/
  // departure capture and PDU validation are exercised in prejoin-lifecycle.
  const state: MembershipState = {
    roomId: '!unheld:remote.test',
    userId: '@alice:logical.test',
    eventId: '$invite-' + sequence,
    roomVersion: '11',
    eventJson: canonicalJson({ retained_signed_event: sequence }),
    inviteRoomState: '[]',
    origin: 'remote.test',
    status: 'pending',
    kind: 'invite',
    localLeaveJson: null,
    publication: null,
  };
  const payload = canonicalJson(state), stream = 'membership:' + state.userId;
  const op: MembershipOperation = {
    source: origin.node,
    incarnation: origin.incarnation,
    sequence,
    operationId: canonicalJson([
      origin.node,
      origin.incarnation,
      stream,
      sequence,
    ]),
    stream,
    semanticKey: canonicalJson(['membership', state.roomId, state.userId]),
    kind: 'membership',
    context: [],
    payload,
    payloadHash: createHash('sha256').update(payload).digest('hex'),
  };
  await server.execute(
    'INSERT INTO domain_operations(operation_id,source,incarnation,stream,sequence,semantic_key,kind,context_json,payload_hash,payload_json,applied) VALUES(?,?,?,?,?,?,?,?,?,?,1)',
    [
      op.operationId,
      op.source,
      op.incarnation,
      stream,
      sequence,
      op.semanticKey,
      op.kind,
      '[]',
      op.payloadHash,
      payload,
    ],
  );
  return op;
}

Deno.test('membership export: signs retained local source facts without a room replica or foreign publication authority', async () => {
  const f = await fixture();
  try {
    const operation = await source(f);
    const records = await f.es.export('alice');
    assertEquals(records.length, 1);
    const record = records[0];
    assertEquals(record.type, 'membership-operation');
    assertEquals(record.stream, 'membership:@alice:logical.test');
    const signed = record.payload as {
      body: { operation: MembershipOperation };
      signature: string;
    };
    assertEquals(signed.body.operation, operation);
    assert(typeof signed.signature === 'string');
    assert(
      await crypto.subtle.verify(
        'Ed25519',
        await importPublicKeyFromRaw(matrixBase64(f.node.publicKey, 32)),
        matrixBase64(signed.signature, 64),
        new TextEncoder().encode(canonicalJson(signed.body)),
      ),
    );
    assertEquals(
      await f.edge.rooms(),
      [],
      'OOB export never creates a joined room',
    );
    assertEquals(
      await f.es.export('alice'),
      [],
      'the source cut prevents duplicate export',
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership export: append failure cannot advance its source cut, and idle scans do no signing', async () => {
  const f = await fixture();
  try {
    await source(f);
    const server = await f.edge.server(), tx = server.tx.bind(server);
    server.tx = (fn) =>
      tx((conn) =>
        fn(
          new Proxy(conn, {
            get(target, property) {
              if (property === 'execute') {
                return (...args: Parameters<typeof conn.execute>) => {
                  if (
                    args[0].includes('INSERT INTO facade_records')
                  ) throw new Error('membership append failed');
                  return target.execute(...args);
                };
              }
              const value = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
        )
      );
    try {
      await assertRejects(
        () => f.es.export('alice'),
        Error,
        'membership append failed',
      );
    } finally {
      server.tx = tx;
    }
    assertEquals(
      await server.query(
        "SELECT * FROM facade_exports WHERE scope LIKE 'membership-export:%'",
      ),
      [],
    );
    assertEquals((await f.es.export('alice')).length, 1);
    let signatures = 0;
    const signer = f.node.signer();
    const es = new MembershipOperations(f.edge, f.et, f.fp, {
      ...f.node,
      signer: () => ({
        ...signer,
        sign: (bytes: string) => {
          signatures++;
          return signer.sign(bytes);
        },
      }),
    });
    assertEquals(await es.export('alice'), []);
    assertEquals(signatures, 0);
  } finally {
    await f.close();
  }
});

Deno.test('membership export: selected account and exact pairing are required in both roles', async () => {
  const f = await fixture();
  try {
    await source(f);
    await source(f, 1, 'home');
    await assertRejects(() => f.es.export('bob'));
    await assertRejects(() => f.hs.export('bob', f.bundle.id));
    await assertRejects(() => f.es.export('alice', 'another-pairing'));
    await assertRejects(() => f.hs.export('alice'));
    assertEquals((await f.hs.export('alice', f.bundle.id)).length, 1);
    assertEquals((await f.es.export('alice')).length, 1);
  } finally {
    await f.close();
  }
});

Deno.test('membership export: a foreign fact cannot acquire this node signature or advance its local source cut', async () => {
  const f = await fixture();
  try {
    const local = await source(f);
    const foreign = await source(f, 2, 'home');
    const server = await f.edge.server();
    await server.execute(
      'INSERT INTO domain_operations(operation_id,source,incarnation,stream,sequence,semantic_key,kind,context_json,payload_hash,payload_json,applied) VALUES(?,?,?,?,?,?,?,?,?,?,1)',
      [
        foreign.operationId,
        foreign.source,
        foreign.incarnation,
        foreign.stream,
        foreign.sequence,
        foreign.semanticKey,
        foreign.kind,
        '[]',
        foreign.payloadHash,
        foreign.payload,
      ],
    );
    const records = await f.es.export('alice');
    assertEquals(records.length, 1);
    assertEquals(
      (records[0].payload as { body: { operation: MembershipOperation } }).body
        .operation,
      local,
    );
    await source(f, 2);
    assertEquals(
      (await f.es.export('alice')).length,
      1,
      'foreign sequence two was never a local watermark',
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership export: authority retirement while signing rolls back append and source advancement', async () => {
  const f = await fixture();
  try {
    await source(f);
    const signer = f.node.signer();
    const owner = new MembershipOperations(f.edge, f.et, f.fp, {
      ...f.node,
      signer: () => ({
        ...signer,
        sign: async (bytes: string) => {
          const signature = await signer.sign(bytes);
          await f.fp.retire(await f.hp.revoke(f.bundle.id), 'a'.repeat(64));
          return signature;
        },
      }),
    });
    await assertRejects(() => owner.export('alice'));
    const db = await f.edge.server();
    assertEquals(
      await db.query(
        "SELECT * FROM facade_exports WHERE scope LIKE 'membership-export:%'",
      ),
      [],
    );
    assertEquals(
      await db.query(
        "SELECT * FROM facade_records WHERE json_extract(record_json,'$.type')='membership-operation'",
      ),
      [],
    );
  } finally {
    await f.close();
  }
});
