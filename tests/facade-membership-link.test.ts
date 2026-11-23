import { assert, assertEquals, assertRejects } from '@std/assert';
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { renderPrejoinDeparture } from '#engine/client/render.ts';
import {
  AccountSnapshots,
  exportAccountAuth,
} from '#engine/facade/accounts.ts';
import { enrolledTenant, initializeNode } from '#engine/facade/identity.ts';
import { Journal } from '#engine/facade/journal.ts';
import { startInboxWorker } from '#engine/facade/worker.ts';
import { replicationProgress } from '#engine/facade/progress.ts';
import {
  MembershipOperations,
  startMembershipExports,
} from '#engine/facade/membership.ts';
import {
  DirectoryReplicas,
  exportDirectoryReplica,
} from '#engine/facade/directory.ts';
import { exportOwnerControl, OwnerControls } from '#engine/facade/ownership.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { changeSigningAuthority } from '#engine/facade/signing-authority.ts';
import {
  LINK_CAPABILITIES,
  LINK_SUPPORTED,
  LinkError,
} from '#engine/facade/protocol.ts';
import { bindRole } from '#engine/facade/role.ts';
import { recordHash } from '#engine/facade/protocol.ts';
import {
  countersign,
  inviteIntentProvider,
  invitesOf,
  prejoinDeparture,
  receiveInvite,
} from '#engine/federation/invites.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import {
  prejoinJobId,
  prejoinJobs,
  prejoinWorkOf,
} from '#engine/server/prejoin-jobs.ts';
import { eventStreamTx, nextEventSeq } from '#engine/server/stream.ts';
import { SERVER_V13 } from '#tests/fixtures/server-v13.ts';
import { retainMembershipOperation } from '#engine/server/membership-history.ts';
import {
  appendMembershipSuccessor,
  recordMembershipOperation,
} from '#engine/server/membership-operations.ts';
import { membershipHistory } from '#engine/server/membership-history.ts';
import { fakeKeyResolver, remoteEvent } from '#tests/fixtures/remote.ts';
import { testRemoteServer, testSigner } from '#tests/fixtures/signer.ts';
import type { LinkRecord } from '#engine/facade/protocol.ts';
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

async function fixture(historicalHome = false, applyAccount = true) {
  const dir = await Deno.makeTempDir({ prefix: 'facade-membership-link-' });
  const settings = (side: string) => ({
    dir: dir + '/' + side,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  const open = (side: string, version = serverSchema.version) =>
    openStore(settings(side), {
      schemas: {
        server: { ...serverSchema, version },
        tenant: tenantSchema,
        room: roomSchema,
      },
    });
  if (historicalHome) {
    const legacy = await openStore(settings('home'), {
      schemas: { server: { version: 13, apply: (db) => db.exec(SERVER_V13) } },
    });
    await legacy.server();
    await legacy.close();
  }
  let home = await open('home', historicalHome ? 51 : serverSchema.version);
  const edge = await open('edge');
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
  if (applyAccount) {
    await new AccountSnapshots(edge, et, fp, owners).apply(ej, auth);
  }
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
    ej,
    owners,
    auth,
    reopenHome: async () => {
      await home.close();
      home = await open('home');
      const tenant = await openTenant(home, 'logical.test');
      const pairings = new Pairings(
        await home.server(),
        tenant.signer(),
        tenant.publicB64,
        'a'.repeat(64),
      );
      return { home, owner: new MembershipOperations(home, tenant, pairings) };
    },
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
  roomId = '!unheld:remote.test',
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
    roomId,
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

async function membershipExportWake(side: 'home' | 'edge') {
  const f = await fixture();
  const store = f[side], tenant = side === 'home' ? f.ht : f.et;
  const server = await store.server();
  const first = Promise.withResolvers<void>();
  const published = Promise.withResolvers<void>();
  let scans = 0;
  let eventId: string | undefined;
  const errors: unknown[] = [];
  const worker = startMembershipExports({
    store,
    server,
    tenant,
    pollseconds: 3600,
    users: () => {
      scans++;
      return Promise.resolve(['alice']);
    },
    emit: async () => {
      const records = side === 'home'
        ? await f.hs.bootstrap('alice', f.bundle.id)
        : await f.es.export('alice');
      if (
        eventId &&
        records.some((record) =>
          JSON.stringify(record.payload).includes(eventId!)
        )
      ) {
        published.resolve();
      }
    },
    changed: () => first.resolve(),
    failed: (error) => {
      errors.push(error);
      published.reject(error);
      first.reject(error);
    },
  });
  try {
    await first.promise;
    const before = scans;
    await eventStreamTx(
      await f[side === 'home' ? 'edge' : 'home'].server(),
      () => Promise.resolve(),
    );
    assertEquals(scans, before, 'another store cannot wake this source');
    await assertRejects(() =>
      eventStreamTx(server, () => {
        throw new Error('rollback wake diagnostic');
      })
    );
    assertEquals(
      scans,
      before,
      'rollback cannot notify a committed membership source',
    );
    const remote = await testRemoteServer('remote.test');
    const roomId = '!wake:remote.test';
    const event = await remoteEvent(roomId, remote, '11', {
      type: 'm.room.member',
      sender: '@inviter:remote.test',
      state_key: '@alice:logical.test',
      content: { membership: 'invite' },
      prev_events: [],
    });
    eventId = String(event.event_id);
    await receiveInvite(
      roomId,
      eventId,
      { room_version: '11', event, invite_room_state: [] },
      remote.name,
      {
        store,
        server,
        self: tenant.serverName,
        signer: tenant.signer(),
        keys: fakeKeyResolver(remote),
        wake() {},
      },
    );
    // eventStreamTx has completed its synchronous post-commit notifications.
    // A scheduled exporter has already entered users(), even if emit is held.
    assert(
      scans > before,
      'server membership commit must admit an export scan without a timer',
    );
    await published.promise;
    assertEquals(errors, []);
    await worker.close();
    const closed = scans;
    await eventStreamTx(server, () => Promise.resolve());
    assertEquals(
      scans,
      closed,
      'closed exporter removes its server subscription',
    );
  } finally {
    await worker.close();
    await f.close();
  }
}

Deno.test('membership export: server-owned OOB commit wakes its exporter without a poll or tenant mutation', async (t) => {
  for (const side of ['home', 'edge'] as const) {
    await t.step(side, () => membershipExportWake(side));
  }
});

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

Deno.test('membership source: retained incomplete foreign history cannot become asserted local causal knowledge', async () => {
  const f = await fixture();
  try {
    const first = await source(f, 1, 'home');
    const pending = await source(f, 3, 'home');
    pending.context = [{
      source: first.source,
      incarnation: first.incarnation,
      sequence: 2,
    }];
    const server = await f.edge.server();
    await server.tx(async (conn) => {
      await retainMembershipOperation(conn, first);
      await retainMembershipOperation(conn, pending);
      const state = JSON.parse(first.payload) as MembershipState;
      await conn.execute(
        'INSERT INTO prejoin_memberships(room_id,user_id,event_id,room_version,event_json,invite_room_state,origin,received_ms,status,seq) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [
          state.roomId,
          state.userId,
          '$local',
          '11',
          state.eventJson,
          '[]',
          state.origin,
          1,
          'pending',
          1,
        ],
      );
      await recordMembershipOperation(conn, state.roomId, state.userId);
    });
    const [local] = await server.query(
      "SELECT context_json FROM domain_operations WHERE source='edge_a'",
    );
    assertEquals(JSON.parse(String(local.context_json)), [{
      source: first.source,
      incarnation: first.incarnation,
      sequence: 1,
    }]);
    assertEquals(
      (await server.query('SELECT * FROM domain_operations')).length,
      3,
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

for (const cut of ['pending-scope', 'pairing', 'revision'] as const) {
  Deno.test(`membership readiness: ${cut} distinguishes pending from conflicting selection`, async () => {
    const f = await fixture();
    try {
      const { record, state, keys } = await incoming(f, 'home');
      await f.ej.receive('home', [record]);
      const server = await f.edge.server();
      const tenant = await f.edge.tenant('logical.test');
      if (cut === 'pending-scope') {
        await server.execute(
          "UPDATE facade_scopes SET ready=0 WHERE scope='auth:@alice:logical.test'",
        );
      } else {
        await tenant.execute(
          cut === 'pairing'
            ? "UPDATE account_auth_snapshots SET pairing='other' WHERE localpart='alice'"
            : "UPDATE account_auth_snapshots SET grant_revision=99 WHERE localpart='alice'",
        );
      }
      const before = await server.query(
        'SELECT * FROM facade_streams ORDER BY stream',
      );
      const refused = await assertRejects(
        () => f.es.apply(f.ej, record, keys),
        LinkError,
      );
      assertEquals(
        refused.code,
        cut === 'pending-scope' ? 'LINK_UNAVAILABLE' : 'LINK_IDENTITY_MISMATCH',
      );
      assertEquals(refused.status, cut === 'pending-scope' ? 503 : 403);
      assertEquals(
        await server.query('SELECT * FROM facade_streams ORDER BY stream'),
        before,
      );
      assertEquals(
        await server.query(
          "SELECT * FROM domain_operations WHERE kind='membership'",
        ),
        [],
      );
      assertEquals(await invitesOf(state.userId, { server }), []);
      if (cut === 'pending-scope') {
        await server.execute(
          "UPDATE facade_scopes SET ready=1 WHERE scope='auth:@alice:logical.test'",
        );
        assertEquals(await f.es.apply(f.ej, record, keys), true);
        assertEquals(
          (await invitesOf(state.userId, { server })).map((invite) =>
            invite.eventId
          ),
          [state.eventId],
        );
      }
    } finally {
      await f.close();
    }
  });
}

Deno.test('membership readiness: home selection blocks retention, export and application without effects', async () => {
  const f = await fixture();
  try {
    const { record, state, keys } = await incoming(f, 'edge');
    const server = await f.home.server();
    const journal = new Journal(server, LINK_SUPPORTED);
    await journal.receive(f.node.node, [record]);
    const [selection] = await server.query(
      "SELECT * FROM facade_exports WHERE incarnation=? AND scope='auth:@alice:logical.test'",
      [f.bundle.id],
    );
    await server.execute(
      "DELETE FROM facade_exports WHERE incarnation=? AND scope='auth:@alice:logical.test'",
      [f.bundle.id],
    );
    const before = await server.query(
      'SELECT * FROM facade_streams ORDER BY stream',
    );
    for (
      const attempt of [
        () => f.hs.retain(record, keys, f.bundle.id),
        () => f.hs.export('alice', f.bundle.id),
        () => f.hs.bootstrap('alice', f.bundle.id),
        () => f.hs.apply(journal, record, keys, f.bundle.id),
      ]
    ) {
      const pending = await assertRejects(attempt, LinkError);
      assertEquals(pending.code, 'LINK_UNAVAILABLE');
      assertEquals(pending.status, 503);
    }
    assertEquals(
      await server.query('SELECT * FROM facade_streams ORDER BY stream'),
      before,
    );
    assertEquals(
      await server.query(
        "SELECT * FROM domain_operations WHERE kind='membership'",
      ),
      [],
    );
    assertEquals(await invitesOf(state.userId, { server }), []);
    await server.execute(
      'INSERT INTO facade_exports(peer,incarnation,scope,source_cut) VALUES(?,?,?,?)',
      [
        selection.peer,
        selection.incarnation,
        selection.scope,
        selection.source_cut,
      ],
    );
    assertEquals(await f.hs.apply(journal, record, keys, f.bundle.id), true);
    assertEquals(
      (await invitesOf(state.userId, { server })).map((invite) =>
        invite.eventId
      ),
      [state.eventId],
    );
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

async function incoming(
  f: Awaited<ReturnType<typeof fixture>>,
  side: 'home' | 'edge' = 'edge',
  kind: 'invite' | 'knock' = 'invite',
  roomId?: string,
  memberContent: Record<string, unknown> = {},
  corruptContent?: Record<string, unknown>,
  initialStatus:
    | 'pending'
    | 'attempting'
    | 'failed-attempt'
    | 'rejecting' = 'pending',
) {
  const operation = await source(f, 1, side, roomId);
  const remote = await testRemoteServer(
    kind === 'knock' ? 'logical.test' : 'remote.test',
  );
  const state = JSON.parse(operation.payload) as MembershipState;
  state.kind = kind;
  state.status = initialStatus;
  const pdu = await remoteEvent(state.roomId, remote, '11', {
    type: 'm.room.member',
    sender: kind === 'knock' ? state.userId : '@inviter:remote.test',
    state_key: state.userId,
    content: { ...memberContent, membership: kind },
    prev_events: [],
  });
  if (corruptContent) pdu.content = { ...pdu.content, ...corruptContent };
  state.eventId = String(pdu.event_id);
  state.eventJson = canonicalJson(pdu);
  operation.payload = canonicalJson(state);
  operation.payloadHash = createHash('sha256').update(operation.payload).digest(
    'hex',
  );
  await (await f[side].server()).execute(
    'UPDATE domain_operations SET payload_json=?,payload_hash=? WHERE operation_id=?',
    [operation.payload, operation.payloadHash, operation.operationId],
  );
  const [record] =
    await (side === 'edge'
      ? f.es.export('alice')
      : f.hs.export('alice', f.bundle.id));
  return { record, state, keys: fakeKeyResolver(remote), operation };
}

async function directoryFixture(f: Awaited<ReturnType<typeof fixture>>) {
  // Directory inventory includes both accounts; selection must precede either
  // account's membership bootstrap, even when that account has no facts.
  await exportAccountAuth(f.home, f.ht, f.hp, f.bundle.id, 'bob', false);
  const journal = new Journal(await f.edge.server(), [...LINK_SUPPORTED, {
    type: 'membership-operation',
    version: 1,
  }]);
  const owner = new DirectoryReplicas(
    await f.edge.server(),
    f.fp,
    'logical.test',
    'f2',
  );
  const publish = async (version: 1 | 2 = 2) => {
    const record = await exportDirectoryReplica(
      f.home,
      f.ht,
      f.node.node,
      f.bundle.id,
      version,
    );
    assert(record);
    await journal.receive('home', [record]);
    assert(await owner.apply(journal, record));
    return record;
  };
  const bootstrap = async () => {
    await f.hs.bootstrap('alice', f.bundle.id);
    await f.hs.bootstrap('bob', f.bundle.id);
  };
  return { journal, owner, publish, bootstrap };
}

Deno.test('membership directory: prepared local-user room admission binds selection and membership prefix', async () => {
  const f = await fixture();
  try {
    const d = await directoryFixture(f);
    await d.bootstrap();
    await d.publish();
    const room = '!new-invite:remote.test';
    // Bob is in public inventory but his selected account has not been applied.
    const denied = await assertRejects(
      () => d.owner.prepareRoomScope(room, true, '@bob:logical.test'),
      MatrixError,
    );
    assertEquals(denied.status, 503);
    const absent = await assertRejects(
      () => d.owner.prepareRoomScope(room, true, '@unselected:logical.test'),
      MatrixError,
    );
    assertEquals(absent.status, 503);
    const admission = await d.owner.prepareRoomScope(
      room,
      true,
      '@alice:logical.test',
    );
    await (await f.edge.server()).tx(admission.check);
    admission.checkCurrent();
    const fact = await incoming(f, 'home');
    await d.journal.receive('home', [fact.record]);
    const changed = await assertRejects(
      async () => (await f.edge.server()).tx(admission.check),
      MatrixError,
    );
    assertEquals(changed.status, 503);
    await assertRejects(
      () => d.owner.prepareRoomScope(room, true, '@alice:logical.test'),
      MatrixError,
    );
    await lifecycleApplication(f.es)(d.journal, fact.record, fact.keys);
    const restored = await d.owner.prepareRoomScope(
      room,
      true,
      '@alice:logical.test',
    );
    await (await f.edge.server()).tx(restored.check);
  } finally {
    await f.close();
  }
});

Deno.test('membership directory: missing bootstrap declaration is unavailable, explicit zero is complete', async () => {
  const f = await fixture();
  try {
    const d = await directoryFixture(f);
    await assertRejects(
      () => exportDirectoryReplica(f.home, f.ht, f.node.node, f.bundle.id, 2),
      Error,
      'membership bootstrap',
    );
    await f.hs.bootstrap('alice', f.bundle.id);
    await assertRejects(
      () => exportDirectoryReplica(f.home, f.ht, f.node.node, f.bundle.id, 2),
      Error,
      'membership bootstrap',
    );
    await f.hs.bootstrap('bob', f.bundle.id);
    const record = await d.publish();
    assertEquals(record.version, 2);
    const { cuts } =
      (record.payload as { view: { cuts: Record<string, number> } }).view;
    assertEquals(cuts['membership:@alice:logical.test'], 0);
    assertEquals(cuts['membership:@bob:logical.test'], 0);
    assertEquals(await d.owner.scopeState('rooms'), 'ready');
  } finally {
    await f.close();
  }
});

Deno.test('membership directory: historical journal prefix, not source counter, must actually apply', async () => {
  const f = await fixture();
  try {
    const d = await directoryFixture(f);
    const fact = await incoming(f, 'home');
    // The already exported source fact is retained history on the current home;
    // its original sequence is unrelated to its new journal position.
    const operation = {
      ...fact.operation,
      incarnation: 'old-home',
      sequence: 41,
    };
    operation.operationId = canonicalJson([
      operation.source,
      operation.incarnation,
      operation.stream,
      operation.sequence,
    ]);
    await (await f.home.server()).execute(
      'UPDATE domain_operations SET operation_id=?,incarnation=?,sequence=? WHERE operation_id=?',
      [
        operation.operationId,
        operation.incarnation,
        operation.sequence,
        fact.operation.operationId,
      ],
    );
    const history = await f.hs.bootstrap('alice', f.bundle.id);
    assertEquals(history.length, 1);
    await f.hs.bootstrap('bob', f.bundle.id);
    const record = await d.publish();
    const { cuts } =
      (record.payload as { view: { cuts: Record<string, number> } }).view;
    assertEquals(cuts['membership:@alice:logical.test'], 2);
    await assertRejects(
      () => d.owner.scopeState('rooms'),
      Error,
      'replica unavailable',
    );
    await d.journal.receive('home', [fact.record, ...history]);
    await lifecycleApplication(f.es)(d.journal, fact.record, fact.keys);
    await assertRejects(
      () => d.owner.scopeState('rooms'),
      Error,
      'replica unavailable',
    );
    await lifecycleApplication(f.es)(d.journal, history[0], fact.keys);
    assertEquals(await d.owner.scopeState('rooms'), 'ready');
    const scope = fact.operation.stream;
    assertEquals(
      (await replicationProgress(f.home, 'logical.test', 'home', [scope]))
        .sources,
      [],
    );
    const status =
      (await replicationProgress(f.edge, 'logical.test', 'facade', [scope]))
        .streams.find((row) => row.direction === 'in')!;
    assertEquals(status.applied.sequence, 2);
    assertEquals(status.applied.sourceCut, 1); // History 41 must not impersonate current authorship.
    assertEquals(status.published?.sourceCut, 1);
    assertEquals(status.declaredCut, 2); // Directory uses the journal prefix.
    assertEquals(
      (await invitesOf('@alice:logical.test', {
        server: await f.edge.server(),
      })).length,
      1,
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership directory: received suffix blocks even an explicit zero inventory until its application', async () => {
  const f = await fixture();
  try {
    const d = await directoryFixture(f);
    await d.bootstrap();
    await d.publish();
    assertEquals(await d.owner.scopeState('rooms'), 'ready');
    const fact = await incoming(f, 'home');
    await d.journal.receive('home', [fact.record]);
    await assertRejects(
      () => d.owner.scopeState('rooms'),
      Error,
      'replica unavailable',
    );
    await lifecycleApplication(f.es)(d.journal, fact.record, fact.keys);
    assertEquals(await d.owner.scopeState('rooms'), 'ready');
    assertEquals(
      (await invitesOf('@alice:logical.test', {
        server: await f.edge.server(),
      })).length,
      1,
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership directory: a failed historical bootstrap cannot reuse an earlier empty declaration', async () => {
  const f = await fixture();
  try {
    const d = await directoryFixture(f);
    await d.bootstrap();
    await d.publish();
    const operation = await source(f, 1, 'home');
    await (await f.home.server()).execute(
      'UPDATE domain_operations SET context_json=? WHERE operation_id=?',
      [
        canonicalJson([{
          source: 'retired',
          incarnation: 'missing',
          sequence: 1,
        }]),
        operation.operationId,
      ],
    );
    await assertRejects(
      () => f.hs.bootstrap('alice', f.bundle.id),
      Error,
      'historical predecessors',
    );
    await assertRejects(
      () => exportDirectoryReplica(f.home, f.ht, f.node.node, f.bundle.id, 2),
      Error,
      'membership bootstrap',
    );
    assertEquals(
      await (await f.home.server()).query(
        "SELECT 1 FROM facade_exports WHERE scope LIKE 'membership-bootstrap:%' AND scope LIKE '%alice%'",
      ),
      [],
    );
    assertEquals(
      (await d.journal.streams('home', 'in')).filter((s) =>
        s.stream.startsWith('membership:')
      ),
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership directory: F1 reader refuses v2 before receiving while F1 v1 never proves F2 completeness', async () => {
  const f = await fixture();
  try {
    const d = await directoryFixture(f);
    await d.publish(1);
    const f1 = new DirectoryReplicas(
      await f.edge.server(),
      f.fp,
      'logical.test',
      'f1',
    );
    assertEquals(await f1.scopeState('rooms'), 'ready');
    await assertRejects(
      () => d.owner.scopeState('rooms'),
      Error,
      'replica unavailable',
    );
    await d.bootstrap();
    const record = await exportDirectoryReplica(
      f.home,
      f.ht,
      f.node.node,
      f.bundle.id,
      2,
    );
    assert(record);
    await assertRejects(
      async () =>
        new Journal(await f.edge.server(), LINK_CAPABILITIES).receive('home', [
          record,
        ]),
      Error,
      'unsupported',
    );
    const [held] = await (await f.edge.server()).query(
      "SELECT received,applied FROM facade_streams WHERE stream='directory' AND direction='in'",
    );
    assertEquals([held.received, held.applied], [1, 1]);
    await d.journal.receive('home', [record]);
    assert(await d.owner.apply(d.journal, record));
    assertEquals(await d.owner.scopeState('rooms'), 'ready');
  } finally {
    await f.close();
  }
});

type MembershipApplication = (
  journal: Journal,
  stream: LinkRecord,
  keys: Parameters<MembershipOperations['retain']>[1],
  pairing?: string,
) => Promise<boolean>;

function lifecycleApplication(owner: MembershipOperations) {
  const apply = (owner as MembershipOperations & {
    apply?: MembershipApplication;
  }).apply;
  assert(apply, 'membership lifecycle application is unavailable');
  return apply.bind(owner);
}

for (const side of ['home', 'edge'] as const) {
  Deno.test(`membership progress: ${side} knock cut waits for actual completion, not receipt or display`, async () => {
    const f = await fixture();
    const release = Promise.withResolvers<void>();
    let applying: Promise<boolean> | undefined;
    try {
      const d = await directoryFixture(f);
      await d.bootstrap();
      await d.publish();
      const fact = await incoming(f, side, 'knock');
      const scope = fact.operation.stream;
      const destination = side === 'home' ? f.edge : f.home;
      const role = side === 'home' ? 'facade' : 'home';
      const sourceStatus = await replicationProgress(
        f[side],
        'logical.test',
        side === 'home' ? 'home' : 'facade',
        [scope],
      );
      assertEquals(sourceStatus.sources, [{
        scope,
        cut: 1,
        source: side === 'home' ? 'home' : f.node.node,
        incarnation: side === 'home' ? f.bundle.id : f.node.incarnation,
      }]);
      const journal = side === 'home'
        ? d.journal
        : new Journal(await f.home.server(), LINK_SUPPORTED);
      await journal.receive(fact.record.source, [fact.record]);
      const inspect = async () =>
        (await replicationProgress(destination, 'logical.test', role, [scope]))
          .streams.find((row) => row.direction === 'in')!;
      assertEquals((await inspect()).received.sourceCut, 1);
      assertEquals((await inspect()).applied.sourceCut, null);
      if (side === 'home') {
        const error = await assertRejects(
          () =>
            d.owner.prepareRoomScope(
              fact.state.roomId,
              true,
              fact.state.userId,
            ),
          MatrixError,
        );
        assertEquals(error.status, 503);
        assertEquals(error.responseBody(), {
          errcode: 'M_UNAVAILABLE',
          error: 'replica unavailable',
        });
        assertEquals(error.body, error.responseBody());
      }
      const held = Promise.withResolvers<void>();
      const complete = journal.complete.bind(journal);
      journal.complete = async (...args) => {
        held.resolve();
        await release.promise;
        return complete(...args);
      };
      applying = lifecycleApplication(side === 'home' ? f.es : f.hs)(
        journal,
        fact.record,
        fact.keys,
        side === 'home' ? undefined : f.bundle.id,
      );
      await held.promise;
      assertEquals((await inspect()).applied.sourceCut, null);
      assertEquals((await inspect()).ready, false);
      release.resolve();
      assertEquals(await applying, true);
      if (side === 'home') await d.publish();
      const applied = await inspect();
      assertEquals(applied.ready, true);
      assertEquals(applied.applied.sourceCut, 1);
      assertEquals(applied.published?.sourceCut, 1);
      assertEquals(
        (await invitesOf(fact.state.userId, {
          server: await destination.server(),
        }))[0].kind,
        'knock',
      );
      const before = await (await destination.server()).query(
        'SELECT total_changes() AS n',
      );
      await inspect();
      assertEquals(
        await (await destination.server()).query('SELECT total_changes() AS n'),
        before,
      );
      await (await destination.server()).execute(
        "UPDATE facade_pairings SET state='revoked'",
      );
      assertEquals((await inspect()).ready, false);
      assertEquals((await inspect()).applied.sourceCut, null);
    } finally {
      release.resolve();
      await applying;
      await f.close();
    }
  });
}

async function exportSuccessor(
  f: Awaited<ReturnType<typeof fixture>>,
  prior: MembershipOperation,
  state: MembershipState,
) {
  const operation = await (await f.edge.server()).tx((conn) =>
    appendMembershipSuccessor(conn, prior, state)
  );
  const records = await f.es.export('alice');
  assertEquals(records.length, 1);
  return { operation, record: records[0] };
}

Deno.test('membership upgrade: an enrolled historical installation freezes local work and never promotes foreign display into a job', async () => {
  const f = await fixture(true);
  try {
    // Seed the historical retraction state without publishing a new pending
    // invite through today's notification schema before the jobs migration.
    const { record, state: foreign, keys, operation } = await incoming(
      f,
      'edge',
      'invite',
      undefined,
      {},
      undefined,
      'rejecting',
    );
    const db = await f.home.server();
    const journal = new Journal(db, [...LINK_SUPPORTED, {
      type: 'membership-operation',
      version: 1,
    }]);
    await journal.receive(record.source, [record]);
    await lifecycleApplication(f.hs)(journal, record, keys, f.bundle.id);
    const local = await testRemoteServer('logical.test');
    const foreignLeave = await remoteEvent(foreign.roomId, local, '11', {
      type: 'm.room.member',
      sender: foreign.userId,
      state_key: foreign.userId,
      content: { membership: 'leave' },
      prev_events: [foreign.eventId],
    });
    foreign.status = 'failed-retract';
    foreign.localLeaveJson = canonicalJson(foreignLeave);
    const next = await exportSuccessor(f, operation, foreign);
    await journal.receive(next.record.source, [next.record]);
    await lifecycleApplication(f.hs)(
      journal,
      next.record,
      fakeKeyResolver(await testRemoteServer('remote.test'), local),
      f.bundle.id,
    );
    const [bound] = await db.query(
      'SELECT * FROM prejoin_memberships WHERE room_id=?',
      [foreign.roomId],
    );
    assert(bound.source_binding !== null);
    const remote = await testRemoteServer('remote.test');
    const roomId = '!legacy-local:remote.test', userId = '@alice:logical.test';
    const invite = await remoteEvent(roomId, remote, '11', {
      type: 'm.room.member',
      sender: '@inviter:remote.test',
      state_key: userId,
      content: { membership: 'invite' },
      prev_events: [],
    });
    const leave = await remoteEvent(roomId, local, '11', {
      type: 'm.room.member',
      sender: userId,
      state_key: userId,
      content: { membership: 'leave', reason: 'existing local work' },
      prev_events: [String(invite.event_id)],
    });
    // Actual pre-jobs schema rows, not a current-schema store with a fake pragma.
    // This is the pre-upgrade local execution intent that migration 51 owns.
    await db.tx(async (conn) => {
      const seq = await nextEventSeq(conn);
      await conn.execute(
        `INSERT INTO prejoin_memberships(room_id,user_id,event_id,room_version,event_json,invite_room_state,origin,received_ms,status,seq,kind,revision,candidates,local_leave_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          roomId,
          userId,
          String(invite.event_id),
          '11',
          canonicalJson(invite),
          '[]',
          'remote.test',
          100,
          'rejecting',
          seq,
          'invite',
          7,
          '["remote.test"]',
          canonicalJson(leave),
        ],
      );
    });
    const [old] = await db.query(
      'SELECT * FROM prejoin_memberships WHERE room_id=?',
      [roomId],
    );
    const expectedWork = prejoinWorkOf(old);
    const beforeEvents = await db.query(
      "SELECT value FROM counters WHERE name='events'",
    );
    assertEquals(
      await db.query(
        "SELECT * FROM domain_operations WHERE source='home' AND kind='membership'",
      ),
      [],
    );
    assertEquals(
      await db.query("SELECT * FROM sqlite_master WHERE name='prejoin_jobs'"),
      [],
    );
    const reopened = await f.reopenHome();
    const current = await reopened.home.server();
    const jobs = await prejoinJobs(current);
    assertEquals(jobs.length, 1);
    assertEquals(jobs[0].id, prejoinJobId(expectedWork));
    assertEquals(jobs[0].work, expectedWork);
    assert(jobs[0].source !== null);
    assertEquals(jobs[0].source.source, 'home');
    const expected: MembershipState = {
      roomId,
      userId,
      eventId: String(invite.event_id),
      roomVersion: '11',
      eventJson: canonicalJson(invite),
      inviteRoomState: '[]',
      origin: 'remote.test',
      status: 'rejecting',
      kind: 'invite',
      localLeaveJson: canonicalJson(leave),
      publication: null,
    };
    assertEquals(jobs[0].source.payload, canonicalJson(expected));
    assertEquals(
      jobs[0].source.payloadHash,
      createHash('sha256').update(canonicalJson(expected)).digest('hex'),
    );
    assertEquals(
      await current.query('SELECT * FROM prejoin_memberships WHERE room_id=?', [
        foreign.roomId,
      ]),
      [bound],
    );
    assertEquals(
      await current.query("SELECT value FROM counters WHERE name='events'"),
      beforeEvents,
    );
    assertEquals(
      (await current.query(
        "SELECT * FROM domain_operations WHERE source='home' AND kind='membership'",
      )).length,
      1,
    );
    const twice = await f.reopenHome();
    const cold = await twice.home.server();
    assertEquals(await prejoinJobs(cold), jobs);
    assertEquals(
      await cold.query('SELECT * FROM prejoin_memberships WHERE room_id=?', [
        foreign.roomId,
      ]),
      [bound],
    );
    assertEquals(
      await cold.query("SELECT value FROM counters WHERE name='events'"),
      beforeEvents,
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership application: account completion wakes a blocked OOB stream without another receive or polling', async () => {
  const f = await fixture(false, false);
  const release = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  let worker: ReturnType<typeof startInboxWorker> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { record, state, keys } = await incoming(f, 'home');
    const db = await f.edge.server();
    await f.ej.receive('home', [record]);
    const failures: unknown[] = [];
    let emptyControlChecks = 0;
    worker = startInboxWorker({
      journal: f.ej,
      peer: 'home',
      pollseconds: 3600,
      changed() {},
      failed(error, stream) {
        failures.push(error);
        if (stream?.stream === record.stream) blocked.resolve();
      },
      async apply(stream) {
        if (stream.stream === 'owner-control') emptyControlChecks++;
        if (stream.stream === f.auth.stream) {
          await release.promise;
          return await new AccountSnapshots(f.edge, f.et, f.fp, f.owners)
            .apply(f.ej, stream);
        }
        if (stream.stream === record.stream) {
          const result = await f.es.apply(f.ej, stream, keys);
          if (result) completed.resolve();
          return result;
        }
        return false;
      },
    });
    await blocked.promise;
    assert(failures[0] instanceof LinkError);
    assertEquals(failures[0].code, 'LINK_UNAVAILABLE');
    assertEquals(failures[0].status, 503);
    assertEquals((await f.ej.heads('home', 'in', record)).applied.sequence, 0);
    assertEquals(await invitesOf(state.userId, { server: db }), []);
    release.resolve();
    await Promise.race([
      completed.promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('dependency completion did not wake membership')),
          3000,
        );
      }),
    ]);
    assertEquals(
      (await f.ej.heads('home', 'in', record)).applied.sequence,
      record.sequence,
    );
    assertEquals(
      (await invitesOf(state.userId, { server: db })).map((invite) =>
        invite.eventId
      ),
      [state.eventId],
    );
    assertEquals(failures.length, 1);
    assertEquals(
      emptyControlChecks,
      1,
      'completed scopes are not rescanned on dependency progress',
    );
  } finally {
    clearTimeout(timer);
    release.resolve();
    await worker?.close();
    await f.close();
  }
});

Deno.test('membership application: authenticated OOB facts reach ordinary invite consumers in both roles before applied ACK', async () => {
  for (const side of ['edge', 'home'] as const) {
    const f = await fixture();
    try {
      const { record, state, keys } = await incoming(f, side);
      const receiver = side === 'edge' ? f.hs : f.es;
      const db = await f[side === 'edge' ? 'home' : 'edge'].server();
      const journal = new Journal(db, [...LINK_SUPPORTED, {
        type: 'membership-operation',
        version: 1,
      }]);
      const apply = lifecycleApplication(receiver);
      const peer = record.source;
      await journal.receive(peer, [record]);
      assertEquals(
        (await journal.heads(peer, 'in', record)).applied.sequence,
        0,
      );
      assertEquals(await invitesOf(state.userId, { server: db }), []);
      assertEquals(await apply(journal, record, keys, f.bundle.id), true);
      const displayed = await invitesOf(state.userId, { server: db });
      assertEquals(displayed.length, 1);
      assertEquals(displayed[0].eventId, state.eventId);
      assertEquals(displayed[0].status, 'pending');
      assertEquals(
        (await journal.heads(peer, 'in', record)).applied.sequence,
        record.sequence,
      );
      assertEquals(await db.query('SELECT * FROM prejoin_jobs'), []);
      assertEquals(
        await db.query(
          'SELECT input_hash,result_json FROM membership_operations',
        ),
        [{
          input_hash: record.hash,
          result_json: canonicalJson({
            operationId:
              (record.payload as { body: { operation: MembershipOperation } })
                .body.operation.operationId,
          }),
        }],
        'the lifecycle commit retains only its exact link completion, not a federation request',
      );
      assertEquals(
        (await db.query(
          "SELECT DISTINCT source FROM domain_operations WHERE kind='membership'",
        )).map((row) => row.source),
        [record.source],
        'import does not re-author an operation at the receiver',
      );
      const before = await db.query('SELECT * FROM counters ORDER BY name');
      assertEquals(await apply(journal, record, keys, f.bundle.id), false);
      assertEquals(
        await db.query('SELECT * FROM counters ORDER BY name'),
        before,
      );
    } finally {
      await f.close();
    }
  }
});

Deno.test('membership application: cold replay retains the exact displayed identity and does not publish twice', async () => {
  const f = await fixture();
  try {
    const { record, state, keys } = await incoming(f);
    let db = await f.home.server();
    let journal = new Journal(db, [...LINK_SUPPORTED, {
      type: 'membership-operation',
      version: 1,
    }]);
    await journal.receive(record.source, [record]);
    await lifecycleApplication(f.hs)(journal, record, keys, f.bundle.id);
    const before = await invitesOf(state.userId, { server: db });
    const counters = await db.query('SELECT * FROM counters ORDER BY name');
    const reopened = await f.reopenHome();
    db = await reopened.home.server();
    journal = new Journal(db, [...LINK_SUPPORTED, {
      type: 'membership-operation',
      version: 1,
    }]);
    assertEquals(await journal.next(record.source, record), null);
    assertEquals(
      await lifecycleApplication(reopened.owner)(
        journal,
        record,
        keys,
        f.bundle.id,
      ),
      false,
    );
    assertEquals(await invitesOf(state.userId, { server: db }), before);
    assertEquals(
      await db.query('SELECT * FROM counters ORDER BY name'),
      counters,
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership application: missing historical closure retains the received head without display or applied ACK', async () => {
  const f = await fixture();
  try {
    const { record, operation, keys } = await incoming(f);
    operation.context = [{
      source: 'old-home',
      incarnation: 'retired',
      sequence: 1,
    }];
    (record.payload as { body: { operation: MembershipOperation } }).body
      .operation = operation;
    await resign(f, record);
    const { hash: _hash, ...body } = record;
    record.hash = recordHash(body);
    const db = await f.home.server();
    const journal = new Journal(db, [...LINK_SUPPORTED, {
      type: 'membership-operation',
      version: 1,
    }]);
    const apply = lifecycleApplication(f.hs);
    await journal.receive(record.source, [record]);
    await assertRejects(() => apply(journal, record, keys, f.bundle.id));
    assertEquals(
      (await journal.heads(record.source, 'in', record)).received.sequence,
      1,
    );
    assertEquals(
      (await journal.heads(record.source, 'in', record)).applied.sequence,
      0,
    );
    assertEquals(await db.query('SELECT * FROM prejoin_memberships'), []);
    assertEquals(await db.query('SELECT * FROM prejoin_jobs'), []);
    assertEquals(
      (await db.query(
        "SELECT * FROM domain_operations WHERE kind='membership'",
      )).length,
      1,
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership application: an owner-committed cold retry finishes its exact journal record after retirement without new verification or publication', async () => {
  const f = await fixture();
  try {
    const { record, state, keys } = await incoming(f);
    let db = await f.home.server();
    let journal = new Journal(db, [...LINK_SUPPORTED, {
      type: 'membership-operation',
      version: 1,
    }]);
    await journal.receive(record.source, [record]);
    journal.complete = () =>
      Promise.reject(new Error('lost journal completion'));
    await assertRejects(
      () => lifecycleApplication(f.hs)(journal, record, keys, f.bundle.id),
      Error,
      'lost journal completion',
    );
    const displayed = await invitesOf(state.userId, { server: db });
    assertEquals(displayed.length, 1);
    assertEquals(
      (await journal.heads(record.source, 'in', record)).applied.sequence,
      0,
    );
    const counters = await db.query('SELECT * FROM counters ORDER BY name');
    await f.hp.revoke(f.bundle.id);
    const reopened = await f.reopenHome();
    db = await reopened.home.server();
    journal = new Journal(db, [...LINK_SUPPORTED, {
      type: 'membership-operation',
      version: 1,
    }]);
    keys.verifyEventSignature = () => {
      throw new Error('retired receipt must not mint new authority');
    };
    assertEquals(
      await lifecycleApplication(reopened.owner)(
        journal,
        record,
        keys,
        f.bundle.id,
      ),
      true,
    );
    assertEquals(
      (await journal.heads(record.source, 'in', record)).applied.sequence,
      record.sequence,
    );
    assertEquals(await invitesOf(state.userId, { server: db }), displayed);
    assertEquals(
      await db.query('SELECT * FROM counters ORDER BY name'),
      counters,
    );
    assertEquals(
      await lifecycleApplication(reopened.owner)(
        journal,
        record,
        keys,
        f.bundle.id,
      ),
      false,
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership application: authenticated retention without a receipt cannot authorize display or ACK after retirement', async () => {
  const f = await fixture();
  try {
    const { record, keys } = await incoming(f);
    const db = await f.home.server();
    const journal = new Journal(db, [...LINK_SUPPORTED, {
      type: 'membership-operation',
      version: 1,
    }]);
    await journal.receive(record.source, [record]);
    await f.hs.retain(record, keys, f.bundle.id);
    await f.hp.revoke(f.bundle.id);
    await assertRejects(() =>
      lifecycleApplication(f.hs)(journal, record, keys, f.bundle.id)
    );
    assertEquals(await db.query('SELECT * FROM prejoin_memberships'), []);
    assertEquals(await db.query('SELECT * FROM membership_operations'), []);
    assertEquals(
      (await journal.heads(record.source, 'in', record)).applied.sequence,
      0,
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership application: failed lifecycle receipt rolls back display, position and selected binding before ACK', async () => {
  const f = await fixture();
  try {
    const { record, keys } = await incoming(f);
    const db = await f.home.server();
    const journal = new Journal(db, [...LINK_SUPPORTED, {
      type: 'membership-operation',
      version: 1,
    }]);
    await journal.receive(record.source, [record]);
    const counters = await db.query('SELECT * FROM counters ORDER BY name');
    const tx = db.tx.bind(db);
    db.tx = (fn) =>
      tx((conn) =>
        fn(
          new Proxy(conn, {
            get(target, property) {
              if (property === 'execute') {
                return (...args: Parameters<typeof conn.execute>) => {
                  if (args[0].includes('INSERT INTO membership_operations')) {
                    throw new Error('membership receipt commit failed');
                  }
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
        () => lifecycleApplication(f.hs)(journal, record, keys, f.bundle.id),
        Error,
        'membership receipt commit failed',
      );
    } finally {
      db.tx = tx;
    }
    assertEquals(await db.query('SELECT * FROM prejoin_memberships'), []);
    assertEquals(await db.query('SELECT * FROM domain_frontiers'), []);
    assertEquals(await db.query('SELECT * FROM membership_operations'), []);
    assertEquals(
      await db.query('SELECT * FROM counters ORDER BY name'),
      counters,
    );
    assertEquals(
      (await journal.heads(record.source, 'in', record)).applied.sequence,
      0,
    );
    assertEquals(
      await lifecycleApplication(f.hs)(journal, record, keys, f.bundle.id),
      true,
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership application: a foreign pending knock displays but never creates a sender or review job', async () => {
  const f = await fixture();
  try {
    const { record, state, keys } = await incoming(f, 'edge', 'knock');
    const db = await f.home.server();
    const journal = new Journal(db, [...LINK_SUPPORTED, {
      type: 'membership-operation',
      version: 1,
    }]);
    await journal.receive(record.source, [record]);
    assertEquals(
      await lifecycleApplication(f.hs)(journal, record, keys, f.bundle.id),
      true,
    );
    const displayed = await invitesOf(state.userId, { server: db });
    assertEquals(displayed.length, 1);
    assertEquals(displayed[0].kind, 'knock');
    const provider = inviteIntentProvider({
      store: f.home,
      server: db,
      signer: f.ht.signer(),
      keys,
      self: 'logical.test',
      wake: () => {},
    });
    assertEquals(await provider.review(), []);
    assertEquals(await provider(db, 'remote.test'), null);
    assertEquals(await db.query('SELECT * FROM prejoin_jobs'), []);
  } finally {
    await f.close();
  }
});

Deno.test('membership evidence: a valid signature enrichment updates exact evidence without a second client position or push', async () => {
  const f = await fixture();
  try {
    const { record, state, keys, operation: first } = await incoming(f);
    const db = await f.home.server();
    const journal = new Journal(db, [...LINK_SUPPORTED, {
      type: 'membership-operation',
      version: 1,
    }]);
    await journal.receive(record.source, [record]);
    await lifecycleApplication(f.hs)(journal, record, keys, f.bundle.id);
    const before = await invitesOf(state.userId, { server: db });
    const counters = await db.query('SELECT * FROM counters ORDER BY name');
    const pdu = JSON.parse(state.eventJson);
    await countersign(pdu, '11', await testSigner('overlay.test'));
    state.eventJson = canonicalJson(pdu);
    const next = await source(f, 2);
    next.context = [{
      source: first.source,
      incarnation: first.incarnation,
      sequence: first.sequence,
    }];
    next.payload = canonicalJson(state);
    next.payloadHash = createHash('sha256').update(next.payload).digest('hex');
    await (await f.edge.server()).execute(
      'UPDATE domain_operations SET payload_json=?,payload_hash=?,context_json=? WHERE operation_id=?',
      [
        next.payload,
        next.payloadHash,
        canonicalJson(next.context),
        next.operationId,
      ],
    );
    const [successor] = await f.es.export('alice');
    await journal.receive(successor.source, [successor]);
    const mergedKeys = fakeKeyResolver(
      await testRemoteServer('remote.test'),
      await testRemoteServer('overlay.test'),
    );
    assertEquals(
      await lifecycleApplication(f.hs)(
        journal,
        successor,
        mergedKeys,
        f.bundle.id,
      ),
      true,
    );
    const displayed = await invitesOf(state.userId, { server: db });
    assertEquals(displayed.length, 1);
    assertEquals(displayed[0].eventId, before[0].eventId);
    assertEquals(
      displayed[0].seq,
      before[0].seq,
      'signature evidence is not another lifecycle publication',
    );
    assertEquals(
      await db.query('SELECT * FROM counters ORDER BY name'),
      counters,
    );
    assert(JSON.parse(displayed[0].eventJson).signatures['overlay.test']);
  } finally {
    await f.close();
  }
});

Deno.test('membership evidence: a hash-mismatched known invite cannot replace accepted content or publish another position', async () => {
  const f = await fixture();
  try {
    const { record, state, keys, operation: first } = await incoming(
      f,
      'edge',
      'invite',
      undefined,
      { displayname: 'Authentic Alice' },
    );
    const db = await f.home.server();
    const journal = new Journal(db, [...LINK_SUPPORTED, {
      type: 'membership-operation',
      version: 1,
    }]);
    await journal.receive(record.source, [record]);
    await lifecycleApplication(f.hs)(journal, record, keys, f.bundle.id);
    const before = await invitesOf(state.userId, { server: db });
    assertEquals(before.length, 1);
    assertEquals(
      JSON.parse(before[0].eventJson).content.displayname,
      'Authentic Alice',
    );
    const counters = await db.query('SELECT * FROM counters ORDER BY name');
    const pdu = JSON.parse(state.eventJson);
    pdu.content.displayname = 'Tampered Alice';
    await countersign(pdu, '11', await testSigner('overlay.test'));
    state.eventJson = canonicalJson(pdu);
    const next = await source(f, 2);
    next.context = [{
      source: first.source,
      incarnation: first.incarnation,
      sequence: first.sequence,
    }];
    next.payload = canonicalJson(state);
    next.payloadHash = createHash('sha256').update(next.payload).digest('hex');
    await (await f.edge.server()).execute(
      'UPDATE domain_operations SET payload_json=?,payload_hash=?,context_json=? WHERE operation_id=?',
      [
        next.payload,
        next.payloadHash,
        canonicalJson(next.context),
        next.operationId,
      ],
    );
    const [successor] = await f.es.export('alice');
    await journal.receive(successor.source, [successor]);
    const remote = await testRemoteServer('remote.test');
    const overlay = await testRemoteServer('overlay.test');
    await assertRejects(
      () =>
        lifecycleApplication(f.hs)(
          journal,
          successor,
          fakeKeyResolver(
            // The optional signature is genuine, but it cannot authorize changed
            // full material for an already accepted event (same as room import).
            remote,
            overlay,
          ),
          f.bundle.id,
        ),
    );
    const displayed = await invitesOf(state.userId, { server: db });
    assertEquals(displayed.length, 1);
    assertEquals(displayed[0].eventId, before[0].eventId);
    assertEquals(
      displayed[0].seq,
      before[0].seq,
      'a redacted receipt for a known event is not new lifecycle news',
    );
    const accepted = JSON.parse(displayed[0].eventJson);
    assertEquals(accepted.content.displayname, 'Authentic Alice');
    assertEquals(accepted.signatures['overlay.test'], undefined);
    assertEquals(
      await db.query('SELECT * FROM counters ORDER BY name'),
      counters,
    );
    assertEquals(await db.query('SELECT * FROM prejoin_jobs'), []);
    assertEquals(
      (await db.query(
        "SELECT DISTINCT source FROM domain_operations WHERE kind='membership'",
      )).map((row) => row.source),
      [successor.source],
    );
    const [bound] = await db.query(
      'SELECT source_binding FROM prejoin_memberships WHERE room_id=? AND user_id=?',
      [state.roomId, state.userId],
    );
    assertEquals(
      JSON.parse(JSON.parse(String(bound.source_binding)).state.eventJson)
        .content.displayname,
      'Authentic Alice',
    );
    assertEquals(
      (await journal.heads(successor.source, 'in', successor)).applied.sequence,
      record.sequence,
    );
    assertEquals(
      (await journal.heads(successor.source, 'in', successor)).received
        .sequence,
      successor.sequence,
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership evidence: cold hash-redaction provenance permits compatible overlays without replacing accepted bytes', async () => {
  for (const originalContent of [{}, { displayname: 'Authentic Alice' }]) {
    const f = await fixture();
    try {
      const { record, state, keys, operation: first } = await incoming(
        f,
        'edge',
        'invite',
        undefined,
        originalContent,
        { displayname: 'Corrupted receipt' },
      );
      let db = await f.home.server();
      let journal = new Journal(db, [...LINK_SUPPORTED, {
        type: 'membership-operation',
        version: 1,
      }]);
      await journal.receive(record.source, [record]);
      await lifecycleApplication(f.hs)(journal, record, keys, f.bundle.id);
      const before = await invitesOf(state.userId, { server: db });
      assertEquals(before.length, 1);
      const accepted = JSON.parse(before[0].eventJson);
      assertEquals(accepted.content, { membership: 'invite' });
      const counters = await db.query('SELECT * FROM counters ORDER BY name');
      const reopened = await f.reopenHome();
      db = await reopened.home.server();
      journal = new Journal(db, [...LINK_SUPPORTED, {
        type: 'membership-operation',
        version: 1,
      }]);
      const raw = JSON.parse(state.eventJson);
      await countersign(raw, '11', await testSigner('overlay.test'));
      state.eventJson = canonicalJson(raw);
      const second = await exportSuccessor(f, first, state);
      await journal.receive(second.record.source, [second.record]);
      const mergedKeys = fakeKeyResolver(
        await testRemoteServer('remote.test'),
        await testRemoteServer('overlay.test'),
      );
      await lifecycleApplication(reopened.owner)(
        journal,
        second.record,
        mergedKeys,
        f.bundle.id,
      );
      const enriched = await invitesOf(state.userId, { server: db });
      assertEquals(enriched[0].seq, before[0].seq);
      const enrichedEvent = JSON.parse(enriched[0].eventJson);
      assertEquals(enrichedEvent.content, accepted.content);
      assert(enrichedEvent.signatures['overlay.test']);
      raw.content = { ...originalContent, membership: 'invite' };
      state.eventJson = canonicalJson(raw);
      const third = await exportSuccessor(f, second.operation, state);
      await journal.receive(third.record.source, [third.record]);
      await lifecycleApplication(reopened.owner)(
        journal,
        third.record,
        mergedKeys,
        f.bundle.id,
      );
      assertEquals(await invitesOf(state.userId, { server: db }), enriched);
      assertEquals(
        await db.query('SELECT * FROM counters ORDER BY name'),
        counters,
      );
      const [bound] = await db.query(
        'SELECT source_binding FROM prejoin_memberships WHERE room_id=? AND user_id=?',
        [state.roomId, state.userId],
      );
      assertEquals(
        JSON.parse(String(bound.source_binding)).provenance.event,
        true,
      );
    } finally {
      await f.close();
    }
  }
});

Deno.test('membership terminal: a verified causal rejection publishes real leave news without signing, jobs or source echo', async () => {
  const f = await fixture();
  try {
    const { record, state, keys, operation: first } = await incoming(f);
    const db = await f.home.server();
    const journal = new Journal(db, [...LINK_SUPPORTED, {
      type: 'membership-operation',
      version: 1,
    }]);
    await journal.receive(record.source, [record]);
    await lifecycleApplication(f.hs)(journal, record, keys, f.bundle.id);
    const before = await invitesOf(state.userId, { server: db });
    assertEquals(before.length, 1);
    const leave = await remoteEvent(
      state.roomId,
      await testRemoteServer('remote.test'),
      '11',
      {
        type: 'm.room.member',
        sender: '@inviter:remote.test',
        state_key: state.userId,
        content: { membership: 'leave', reason: 'authentic rescind' },
        prev_events: [state.eventId],
      },
    );
    state.status = 'rejected';
    state.eventJson = canonicalJson(leave);
    const next = await source(f, 2);
    next.context = [{
      source: first.source,
      incarnation: first.incarnation,
      sequence: first.sequence,
    }];
    next.payload = canonicalJson(state);
    next.payloadHash = createHash('sha256').update(next.payload).digest('hex');
    await (await f.edge.server()).execute(
      'UPDATE domain_operations SET payload_json=?,payload_hash=?,context_json=? WHERE operation_id=?',
      [
        next.payload,
        next.payloadHash,
        canonicalJson(next.context),
        next.operationId,
      ],
    );
    const [successor] = await f.es.export('alice');
    await journal.receive(successor.source, [successor]);
    await lifecycleApplication(f.hs)(journal, successor, keys, f.bundle.id);
    const displayed = await invitesOf(state.userId, { server: db });
    assertEquals(
      displayed.length,
      1,
      'terminal membership is published, not deleted',
    );
    assertEquals(displayed[0].eventId, state.eventId);
    assertEquals(displayed[0].status, 'rejected');
    assert(displayed[0].seq > before[0].seq);
    const departure = await prejoinDeparture(displayed[0], {
      server: db,
      signer: {
        ...f.ht.signer(),
        sign: () => {
          throw new Error('import must not sign a departure');
        },
      },
    });
    assert(departure);
    assertEquals(
      renderPrejoinDeparture(departure, state.userId, 'client'),
      {
        event_id: leave.event_id,
        type: 'm.room.member',
        sender: leave.sender,
        state_key: state.userId,
        content: leave.content,
        origin_server_ts: leave.origin_server_ts,
      },
    );
    await db.tx((conn) =>
      recordMembershipOperation(conn, state.roomId, state.userId)
    );
    assertEquals(
      (await db.query(
        "SELECT * FROM domain_operations WHERE kind='membership'",
      )).length,
      2,
    );
    assertEquals(await db.query('SELECT * FROM prejoin_jobs'), []);
    const counters = await db.query('SELECT * FROM counters ORDER BY name');
    assertEquals(
      await lifecycleApplication(f.hs)(journal, successor, keys, f.bundle.id),
      false,
    );
    assertEquals(
      await db.query('SELECT * FROM counters ORDER BY name'),
      counters,
    );
    assertEquals(
      (await journal.heads(successor.source, 'in', successor)).applied.sequence,
      successor.sequence,
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership source intent: unperformed knock facts complete without foreign execution and cannot block their accepted successor', async () => {
  const f = await fixture();
  try {
    const { record, state, keys, operation: first } = await incoming(
      f,
      'edge',
      'knock',
      undefined,
      {},
      undefined,
      'attempting',
    );
    const db = await f.home.server();
    const journal = new Journal(db, [...LINK_SUPPORTED, {
      type: 'membership-operation',
      version: 1,
    }]);
    let current = record, prior = first;
    const counters = await db.query('SELECT * FROM counters ORDER BY name');
    for (const status of ['attempting', 'failed-attempt', 'pending']) {
      if (status !== 'attempting') {
        state.status = status;
        const next = await exportSuccessor(f, prior, state);
        current = next.record;
        prior = next.operation;
      }
      await journal.receive(current.source, [current]);
      assertEquals(
        await lifecycleApplication(f.hs)(journal, current, keys, f.bundle.id),
        true,
      );
      assertEquals(
        (await journal.heads(current.source, 'in', current)).applied.sequence,
        current.sequence,
      );
      assertEquals(await db.query('SELECT * FROM prejoin_jobs'), []);
      const displayed = await invitesOf(state.userId, { server: db });
      if (status === 'pending') {
        assertEquals(displayed.length, 1);
        assertEquals(displayed[0].eventId, state.eventId);
        assertEquals(displayed[0].kind, 'knock');
        assertEquals(displayed[0].status, 'pending');
      } else {
        assertEquals(
          displayed,
          [],
          'an unperformed foreign knock is not membership news',
        );
        assertEquals(
          await db.query('SELECT * FROM counters ORDER BY name'),
          counters,
        );
      }
    }
    assertEquals(
      (await db.query(
        "SELECT * FROM domain_operations WHERE kind='membership'",
      )).length,
      3,
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership source intent: legacy retraction without a departure completes before its real signed leave successor', async () => {
  for (const kind of ['invite', 'knock'] as const) {
    const f = await fixture();
    try {
      const { record, state, keys, operation: first } = await incoming(
        f,
        'edge',
        kind,
        undefined,
        {},
        undefined,
        'rejecting',
      );
      const db = await f.home.server();
      const journal = new Journal(db, [...LINK_SUPPORTED, {
        type: 'membership-operation',
        version: 1,
      }]);
      const before = await db.query('SELECT * FROM counters ORDER BY name');
      let current = record, prior = first;
      for (const status of ['rejecting', 'failed-retract']) {
        if (status !== 'rejecting') {
          state.status = status;
          const next = await exportSuccessor(f, prior, state);
          current = next.record;
          prior = next.operation;
        }
        await journal.receive(current.source, [current]);
        assertEquals(
          await lifecycleApplication(f.hs)(journal, current, keys, f.bundle.id),
          true,
        );
        assertEquals(
          (await journal.heads(current.source, 'in', current)).applied.sequence,
          current.sequence,
        );
        assertEquals(
          await invitesOf(state.userId, { server: db }),
          [],
          'unperformed retraction cannot fabricate leave news',
        );
        assertEquals(await db.query('SELECT * FROM prejoin_jobs'), []);
        assertEquals(
          await db.query('SELECT * FROM counters ORDER BY name'),
          before,
        );
      }
      const local = await testRemoteServer('logical.test');
      const leave = await remoteEvent(state.roomId, local, '11', {
        type: 'm.room.member',
        sender: state.userId,
        state_key: state.userId,
        content: { membership: 'leave', reason: 'legacy rejection completed' },
        prev_events: [state.eventId],
      });
      state.localLeaveJson = canonicalJson(leave);
      const resolver = fakeKeyResolver(
        await testRemoteServer('remote.test'),
        local,
      );
      let position: number | null = null;
      for (const status of ['failed-retract', 'rejected']) {
        state.status = status;
        const next = await exportSuccessor(f, prior, state);
        await journal.receive(next.record.source, [next.record]);
        assertEquals(
          await lifecycleApplication(f.hs)(
            journal,
            next.record,
            resolver,
            f.bundle.id,
          ),
          true,
        );
        const displayed = await invitesOf(state.userId, { server: db });
        assertEquals(displayed.length, 1);
        if (position !== null) assertEquals(displayed[0].seq, position);
        position = displayed[0].seq;
        const departure = await prejoinDeparture(displayed[0], {
          server: db,
          signer: {
            ...f.ht.signer(),
            sign: () => {
              throw new Error('receiver must never sign foreign legacy work');
            },
          },
        });
        assert(departure);
        assertEquals(
          renderPrejoinDeparture(departure, state.userId, 'client').event_id,
          leave.event_id,
        );
        assertEquals(await db.query('SELECT * FROM prejoin_jobs'), []);
        assertEquals(
          (await journal.heads(next.record.source, 'in', next.record)).applied
            .sequence,
          next.record.sequence,
        );
        prior = next.operation;
      }
    } finally {
      await f.close();
    }
  }
});

Deno.test('membership terminal authority: actual local leave survives source job status transitions without another position', async () => {
  const f = await fixture();
  try {
    const { record, state, keys, operation: first } = await incoming(f);
    const db = await f.home.server();
    const journal = new Journal(db, [...LINK_SUPPORTED, {
      type: 'membership-operation',
      version: 1,
    }]);
    await journal.receive(record.source, [record]);
    await lifecycleApplication(f.hs)(journal, record, keys, f.bundle.id);
    const invite = (await invitesOf(state.userId, { server: db }))[0];
    const local = await testRemoteServer('logical.test');
    const leave = await remoteEvent(state.roomId, local, '11', {
      type: 'm.room.member',
      sender: state.userId,
      state_key: state.userId,
      content: { membership: 'leave', reason: 'local rejection' },
      prev_events: [state.eventId],
    });
    state.localLeaveJson = canonicalJson(leave);
    const resolver = fakeKeyResolver(
      await testRemoteServer('remote.test'),
      local,
    );
    let prior = first, seq: number | null = null;
    for (const status of ['rejecting', 'failed-retract', 'rejected']) {
      state.status = status;
      const next = await exportSuccessor(f, prior, state);
      await journal.receive(next.record.source, [next.record]);
      await lifecycleApplication(f.hs)(
        journal,
        next.record,
        resolver,
        f.bundle.id,
      );
      const displayed = (await invitesOf(state.userId, { server: db }))[0];
      assertEquals(displayed.status, status);
      assert(displayed.seq > invite.seq);
      if (seq !== null) assertEquals(displayed.seq, seq);
      seq = displayed.seq;
      const departure = await prejoinDeparture(displayed, {
        server: db,
        signer: {
          ...f.ht.signer(),
          sign: () => {
            throw new Error('foreign leave must not be signed');
          },
        },
      });
      assert(departure);
      assertEquals(
        renderPrejoinDeparture(departure, state.userId, 'client').event_id,
        leave.event_id,
      );
      assertEquals(await db.query('SELECT * FROM prejoin_jobs'), []);
      assertEquals(
        (await journal.heads(next.record.source, 'in', next.record)).applied
          .sequence,
        next.record.sequence,
      );
      prior = next.operation;
    }
  } finally {
    await f.close();
  }
});

Deno.test('membership terminal authority: missing departure evidence cannot erase an unheld invite or acquire an applied ACK', async () => {
  const f = await fixture();
  try {
    const { record, state, keys, operation } = await incoming(f);
    const db = await f.home.server();
    const journal = new Journal(db, [...LINK_SUPPORTED, {
      type: 'membership-operation',
      version: 1,
    }]);
    await journal.receive(record.source, [record]);
    await lifecycleApplication(f.hs)(journal, record, keys, f.bundle.id);
    const before = await invitesOf(state.userId, { server: db });
    const counters = await db.query('SELECT * FROM counters ORDER BY name');
    state.status = 'rejected';
    const next = await exportSuccessor(f, operation, state);
    await journal.receive(next.record.source, [next.record]);
    await assertRejects(
      () => lifecycleApplication(f.hs)(journal, next.record, keys, f.bundle.id),
      Error,
      'display evidence',
    );
    assertEquals(await invitesOf(state.userId, { server: db }), before);
    assertEquals(
      await db.query('SELECT * FROM counters ORDER BY name'),
      counters,
    );
    const heads = await journal.heads(next.record.source, 'in', next.record);
    assertEquals(heads.received.sequence, next.record.sequence);
    assertEquals(heads.applied.sequence, record.sequence);
  } finally {
    await f.close();
  }
});

Deno.test('membership terminal authority: joined source evidence completes only behind authentic held DAG authority without an OOB join', async () => {
  for (const held of [false, true]) {
    const f = await fixture();
    try {
      const roomId = held
        ? (await createRoom(
          f.home,
          { creator: '@alice:logical.test' },
          f.ht.signer(),
        )).roomId
        : '!unheld:remote.test';
      const { record, state, keys, operation } = await incoming(
        f,
        'edge',
        'invite',
        roomId,
      );
      const db = await f.home.server();
      const journal = new Journal(db, [...LINK_SUPPORTED, {
        type: 'membership-operation',
        version: 1,
      }]);
      await journal.receive(record.source, [record]);
      await lifecycleApplication(f.hs)(journal, record, keys, f.bundle.id);
      const before = await db.query('SELECT * FROM memberships');
      const displayed = await invitesOf(state.userId, { server: db });
      const counters = await db.query('SELECT * FROM counters ORDER BY name');
      state.status = 'joined';
      const next = await exportSuccessor(f, operation, state);
      await journal.receive(next.record.source, [next.record]);
      if (held) {
        assertEquals(
          await lifecycleApplication(f.hs)(
            journal,
            next.record,
            keys,
            f.bundle.id,
          ),
          true,
        );
      } else {
        await assertRejects(
          () =>
            lifecycleApplication(f.hs)(journal, next.record, keys, f.bundle.id),
          Error,
          'display evidence',
        );
      }
      assertEquals(await db.query('SELECT * FROM memberships'), before);
      assertEquals(await invitesOf(state.userId, { server: db }), displayed);
      assertEquals(
        await db.query('SELECT * FROM counters ORDER BY name'),
        counters,
      );
      assertEquals(
        (await journal.heads(next.record.source, 'in', next.record)).applied
          .sequence,
        held ? next.record.sequence : record.sequence,
      );
      assertEquals(await db.query('SELECT * FROM prejoin_jobs'), []);
    } finally {
      await f.close();
    }
  }
});

Deno.test('membership terminal: rejection suppresses only its original invitation and preserves a distinct concurrent invite', async () => {
  const f = await fixture();
  try {
    const { record, state, keys, operation: first } = await incoming(f);
    const db = await f.home.server();
    const journal = new Journal(db, [...LINK_SUPPORTED, {
      type: 'membership-operation',
      version: 1,
    }]);
    await journal.receive(record.source, [record]);
    await lifecycleApplication(f.hs)(journal, record, keys, f.bundle.id);
    const other = await incoming(f, 'home', 'invite', state.roomId, {
      displayname: 'Distinct concurrent invite',
    });
    assert(other.state.eventId !== state.eventId);
    const leave = await remoteEvent(
      state.roomId,
      await testRemoteServer('remote.test'),
      '11',
      {
        type: 'm.room.member',
        sender: '@inviter:remote.test',
        state_key: state.userId,
        content: { membership: 'leave' },
        prev_events: [state.eventId],
      },
    );
    state.status = 'rejected';
    state.eventJson = canonicalJson(leave);
    const terminal = await exportSuccessor(f, first, state);
    await journal.receive(terminal.record.source, [terminal.record]);
    await lifecycleApplication(f.hs)(
      journal,
      terminal.record,
      keys,
      f.bundle.id,
    );
    const displayed = await invitesOf(state.userId, { server: db });
    assertEquals(displayed.length, 1);
    assertEquals(displayed[0].eventId, other.state.eventId);
    assertEquals(displayed[0].status, 'pending');
    assertEquals(
      (await db.query(
        "SELECT * FROM domain_operations WHERE kind='membership'",
      )).length,
      3,
    );
    await db.tx((conn) =>
      recordMembershipOperation(conn, state.roomId, state.userId)
    );
    assertEquals(
      (await db.query(
        "SELECT * FROM domain_operations WHERE kind='membership'",
      )).length,
      3,
    );
    assertEquals(await db.query('SELECT * FROM prejoin_jobs'), []);
  } finally {
    await f.close();
  }
});

Deno.test('membership evidence: a genuinely held room keeps its normal DAG state and receives no OOB display or client position', async () => {
  const f = await fixture();
  try {
    const created = await createRoom(
      f.home,
      { creator: '@alice:logical.test' },
      f.ht.signer(),
    );
    const room = await openRoom(f.home, created.roomId);
    const capture = () =>
      room.tx(async (tx) => {
        const stay = await tx.segments.openStay();
        assert(stay);
        const group = await tx.state.current(stay.id);
        assert(group !== null);
        return await tx.state.groupEntries(group);
      });
    const before = await capture();
    const { record, state, keys } = await incoming(
      f,
      'edge',
      'invite',
      created.roomId,
    );
    const db = await f.home.server();
    const counters = await db.query('SELECT * FROM counters ORDER BY name');
    const journal = new Journal(db, [...LINK_SUPPORTED, {
      type: 'membership-operation',
      version: 1,
    }]);
    await journal.receive(record.source, [record]);
    assertEquals(
      await lifecycleApplication(f.hs)(journal, record, keys, f.bundle.id),
      true,
    );
    assertEquals(await capture(), before);
    assertEquals(await invitesOf(state.userId, { server: db }), []);
    assertEquals(
      await db.query('SELECT * FROM counters ORDER BY name'),
      counters,
    );
    assertEquals(
      (await journal.heads(record.source, 'in', record)).applied.sequence,
      record.sequence,
    );
  } finally {
    await f.close();
  }
});

async function resign(
  f: Awaited<ReturnType<typeof fixture>>,
  record: LinkRecord,
) {
  const signed = record.payload as {
    body: Record<string, unknown>;
    signature: string;
  };
  signed.signature = await f.node.signer().sign(canonicalJson(signed.body));
}

Deno.test('membership admission: authentic facts retain in both roles without display, publication or journal completion', async () => {
  for (const side of ['edge', 'home'] as const) {
    const f = await fixture();
    try {
      const { record, state, keys } = await incoming(f, side);
      const receiver = side === 'edge' ? f.hs : f.es;
      const db = await f[side === 'edge' ? 'home' : 'edge'].server();
      const before = await db.query('SELECT * FROM counters');
      assertEquals(await receiver.retain(record, keys, f.bundle.id), state);
      assertEquals(await receiver.retain(record, keys, f.bundle.id), state);
      assertEquals(
        (await db.query(
          "SELECT * FROM domain_operations WHERE kind='membership'",
        )).length,
        1,
      );
      assertEquals(await db.query('SELECT * FROM prejoin_memberships'), []);
      assertEquals(await db.query('SELECT * FROM membership_operations'), []);
      assertEquals(await db.query('SELECT * FROM domain_frontiers'), []);
      assertEquals(await db.query('SELECT * FROM counters'), before);
      const history = await db.tx((conn) =>
        membershipHistory(
          conn,
          canonicalJson(['membership', state.roomId, state.userId]),
        )
      );
      assertEquals(history.ready.length, 1);
    } finally {
      await f.close();
    }
  }
});

Deno.test('membership admission: enrolled signatures and record identity are authority, not private payload claims', async (t) => {
  for (
    const change of [
      'signature',
      'source',
      'stream',
      'incarnation',
      'operationId',
      'version',
    ] as const
  ) {
    await t.step(change, async () => {
      const f = await fixture();
      try {
        const { record, keys } = await incoming(f);
        if (change === 'signature') {
          (record.payload as { signature: string }).signature = 'A'.repeat(86);
        } else if (change === 'version') record.version++;
        else record[change] = 'wrong';
        await assertRejects(() => f.hs.retain(record, keys, f.bundle.id));
        assertEquals(
          await (await f.home.server()).query(
            "SELECT * FROM domain_operations WHERE kind='membership'",
          ),
          [],
        );
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('membership admission: signed account/source substitution and unselected accounts cannot retain facts', async (t) => {
  for (
    const change of [
      'localpart',
      'source',
      'incarnation',
      'pairing',
      'grantRevision',
      'ownerRevision',
    ] as const
  ) {
    await t.step(change, async () => {
      const f = await fixture();
      try {
        const { record, keys } = await incoming(f);
        const body = (record.payload as { body: Record<string, unknown> }).body;
        body[change] = change.endsWith('Revision') ? 999 : 'bob';
        await resign(f, record);
        await assertRejects(() => f.hs.retain(record, keys, f.bundle.id));
        assertEquals(
          await (await f.home.server()).query(
            "SELECT * FROM domain_operations WHERE kind='membership'",
          ),
          [],
        );
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('membership admission: link-authenticated payload still needs actual PDU signature and lifecycle identity', async (t) => {
  for (
    const change of ['signature', 'eventId', 'userId', 'localLeave'] as const
  ) {
    await t.step(change, async () => {
      const f = await fixture();
      try {
        const { record, keys, state, operation } = await incoming(f);
        if (change === 'signature') {
          const pdu = JSON.parse(state.eventJson);
          pdu.signatures['remote.test']['ed25519:test'] = 'A'.repeat(86);
          state.eventJson = canonicalJson(pdu);
        } else if (change === 'eventId') state.eventId = '$substituted';
        else if (change === 'userId') state.userId = '@bob:logical.test';
        else state.localLeaveJson = state.eventJson;
        operation.payload = canonicalJson(state);
        operation.payloadHash = createHash('sha256').update(operation.payload)
          .digest('hex');
        (record.payload as { body: { operation: MembershipOperation } }).body
          .operation = operation;
        await resign(f, record);
        await assertRejects(() => f.hs.retain(record, keys, f.bundle.id));
        assertEquals(
          await (await f.home.server()).query(
            "SELECT * FROM domain_operations WHERE kind='membership'",
          ),
          [],
        );
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('membership admission: retirement during key verification cannot commit retained facts', async () => {
  const f = await fixture();
  try {
    const { record, keys } = await incoming(f, 'home');
    const verifying = keys.verifyEventSignature.bind(keys);
    keys.verifyEventSignature = async (args) => {
      const valid = await verifying(args);
      await f.fp.retire(await f.hp.revoke(f.bundle.id), 'a'.repeat(64));
      return valid;
    };
    await assertRejects(() => f.es.retain(record, keys));
    assertEquals(
      await (await f.edge.server()).query(
        "SELECT * FROM domain_operations WHERE kind='membership'",
      ),
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership admission: invalidation after retention callback cannot cross native commit', async () => {
  const f = await fixture();
  const server = await f.edge.server();
  const original = server.tx.bind(server);
  try {
    const { record, keys } = await incoming(f, 'home');
    server.tx = (fn, options) =>
      original(async (conn) => {
        const result = await fn(conn);
        const retained = await conn.query(
          "SELECT 1 FROM domain_operations WHERE kind='membership'",
        );
        if (retained.length) {
          // Complete a no-storage invalidation after the last owner callback check.
          await changeSigningAuthority(server, () =>
            Promise.resolve(), () =>
            Promise.resolve());
        }
        return result;
      }, options);
    await assertRejects(() => f.es.retain(record, keys));
    server.tx = original;
    assertEquals(
      await server.query(
        "SELECT * FROM domain_operations WHERE kind='membership'",
      ),
      [],
    );
  } finally {
    server.tx = original;
    await f.close();
  }
});

Deno.test('membership admission: a correctly signed unselected account is refused before key lookup', async () => {
  const f = await fixture();
  try {
    const { record, keys, state, operation } = await incoming(f);
    const body = (record.payload as { body: Record<string, unknown> }).body;
    state.userId = '@bob:logical.test';
    operation.stream = 'membership:' + state.userId;
    operation.semanticKey = canonicalJson([
      'membership',
      state.roomId,
      state.userId,
    ]);
    operation.operationId = canonicalJson([
      operation.source,
      operation.incarnation,
      operation.stream,
      operation.sequence,
    ]);
    operation.payload = canonicalJson(state);
    operation.payloadHash = createHash('sha256').update(operation.payload)
      .digest('hex');
    body.localpart = 'bob';
    body.operation = operation;
    record.stream = operation.stream;
    record.operationId = 'membership:' +
      createHash('sha256').update(canonicalJson([
        body.pairing,
        body.grantRevision,
        body.ownerRevision,
        operation.operationId,
      ])).digest('hex');
    await resign(f, record);
    let lookedUp = false;
    keys.verifyEventSignature = () => {
      lookedUp = true;
      return Promise.resolve(true);
    };
    await assertRejects(() => f.hs.retain(record, keys, f.bundle.id));
    assertEquals(lookedUp, false);
    assertEquals(
      await (await f.home.server()).query(
        "SELECT * FROM domain_operations WHERE kind='membership'",
      ),
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership admission: key verification stays outside the retaining transaction and incomplete causal history stays pending', async () => {
  const f = await fixture();
  try {
    const { record, keys, state, operation } = await incoming(f);
    operation.context = [{
      source: 'home',
      incarnation: 'missing-history',
      sequence: 7,
    }];
    (record.payload as { body: { operation: MembershipOperation } }).body
      .operation = operation;
    await resign(f, record);
    const db = await f.home.server(), tx = db.tx.bind(db);
    let inTransaction = false, checked = false;
    db.tx = (fn) =>
      tx(async (conn) => {
        inTransaction = true;
        try {
          return await fn(conn);
        } finally {
          inTransaction = false;
        }
      });
    const verifying = keys.verifyEventSignature.bind(keys);
    keys.verifyEventSignature = (args) => {
      assertEquals(inTransaction, false);
      checked = true;
      return verifying(args);
    };
    await f.hs.retain(record, keys, f.bundle.id);
    assertEquals(checked, true);
    const history = await db.tx((conn) =>
      membershipHistory(conn, operation.semanticKey)
    );
    assertEquals(history.ready, []);
    assertEquals(history.pending.length, 1);
    assertEquals(await db.query('SELECT * FROM prejoin_memberships'), []);
    assertEquals(await db.query('SELECT * FROM memberships'), []);
    assertEquals(JSON.parse(history.pending[0].payload), state);
  } finally {
    await f.close();
  }
});

Deno.test('membership admission: retained room and origin cannot be substituted around a valid PDU', async (t) => {
  for (const change of ['room', 'origin'] as const) {
    await t.step(change, async () => {
      const f = await fixture();
      try {
        const { record, keys, state, operation } = await incoming(f);
        if (change === 'room') {
          state.roomId = '!another:remote.test';
          operation.semanticKey = canonicalJson([
            'membership',
            state.roomId,
            state.userId,
          ]);
        } else state.origin = 'different.test';
        operation.payload = canonicalJson(state);
        operation.payloadHash = createHash('sha256').update(operation.payload)
          .digest('hex');
        (record.payload as { body: { operation: MembershipOperation } }).body
          .operation = operation;
        await resign(f, record);
        await assertRejects(() => f.hs.retain(record, keys, f.bundle.id));
        assertEquals(
          await (await f.home.server()).query(
            "SELECT * FROM domain_operations WHERE kind='membership'",
          ),
          [],
        );
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('membership admission: verified terminal leave retains original invitation identity, not an invented matching event ID', async () => {
  const f = await fixture();
  try {
    const { record, keys, state, operation } = await incoming(f);
    const remote = await testRemoteServer('remote.test');
    const leave = await remoteEvent(state.roomId, remote, '11', {
      type: 'm.room.member',
      sender: '@inviter:remote.test',
      state_key: state.userId,
      content: { membership: 'leave' },
      prev_events: [state.eventId],
    });
    assert(leave.event_id !== state.eventId);
    state.status = 'rejected';
    state.eventJson = canonicalJson(leave);
    operation.payload = canonicalJson(state);
    operation.payloadHash = createHash('sha256').update(operation.payload)
      .digest('hex');
    (record.payload as { body: { operation: MembershipOperation } }).body
      .operation = operation;
    await resign(f, record);
    assertEquals(await f.hs.retain(record, keys, f.bundle.id), state);
    assertEquals(
      await (await f.home.server()).query('SELECT * FROM prejoin_memberships'),
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership admission: an accepted local-user knock keeps the remote resident origin without foreign execution', async () => {
  const f = await fixture();
  try {
    const { record, state, operation } = await incoming(f);
    const local = await testRemoteServer('logical.test');
    const knock = await remoteEvent(state.roomId, local, '11', {
      type: 'm.room.member',
      sender: state.userId,
      state_key: state.userId,
      content: { membership: 'knock' },
      prev_events: [],
    });
    state.kind = 'knock';
    state.eventId = String(knock.event_id);
    state.eventJson = canonicalJson(knock);
    operation.payload = canonicalJson(state);
    operation.payloadHash = createHash('sha256').update(operation.payload)
      .digest('hex');
    (record.payload as { body: { operation: MembershipOperation } }).body
      .operation = operation;
    await resign(f, record);
    assertEquals(
      await f.hs.retain(record, fakeKeyResolver(local), f.bundle.id),
      state,
    );
    const db = await f.home.server();
    assertEquals(await db.query('SELECT * FROM prejoin_memberships'), []);
    assertEquals(
      await db.query('SELECT * FROM federation_invite_attempts'),
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership history: home attests exact retained foreign dots without restamping or advancing a local source cut', async () => {
  const f = await fixture();
  try {
    const { record, keys, operation, state } = await incoming(f);
    await f.hs.retain(record, keys, f.bundle.id);
    const before = await (await f.home.server()).query(
      'SELECT * FROM counters',
    );
    const records = await f.hs.bootstrap('alice', f.bundle.id);
    assertEquals(records.length, 1);
    const history = records[0];
    const body = (history.payload as {
      body: { kind: string; operation: MembershipOperation };
    }).body;
    assertEquals(body.kind, 'membership-history');
    assertEquals(body.operation, operation);
    assertEquals(history.source, 'home');
    assertEquals(await f.es.retain(history, keys), state);
    assertEquals(
      await (await f.home.server()).query('SELECT * FROM counters'),
      before,
    );
    assertEquals(await f.hs.export('alice', f.bundle.id), []);
    assertEquals(
      await (await f.edge.server()).query('SELECT * FROM prejoin_memberships'),
      [],
    );
    assertEquals(
      await (await f.edge.server()).query(
        'SELECT * FROM membership_operations',
      ),
      [],
    );
    assertEquals(
      (await f.hs.bootstrap('alice', f.bundle.id))[0],
      history,
      'exact bootstrap retries retain journal identity',
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership bootstrap scheduling: historical predecessors precede current-source successors on the actual journal', async () => {
  const f = await fixture();
  try {
    const home = await f.home.server();
    const predecessor = await source(f, 1, 'edge');
    await home.tx((conn) => retainMembershipOperation(conn, predecessor));
    const successor = await source(f, 1, 'home');
    successor.context = [{
      source: predecessor.source,
      incarnation: predecessor.incarnation,
      sequence: predecessor.sequence,
    }];
    await home.execute(
      'UPDATE domain_operations SET context_json=? WHERE operation_id=?',
      [canonicalJson(successor.context), successor.operationId],
    );
    const records = await f.hs.bootstrap('alice', f.bundle.id);
    assertEquals(
      records.map((record) =>
        (record.payload as { body: { operation: MembershipOperation } }).body
          .operation.operationId
      ),
      [predecessor.operationId, successor.operationId],
    );
    assertEquals(records.map((record) => record.sequence), [1, 2]);
    assertEquals(records[1].previous, records[0].hash);
    const actual = await home.query(
      "SELECT record_json FROM facade_records WHERE direction='out' AND stream=? ORDER BY sequence",
      [successor.stream],
    );
    assertEquals(
      actual.map((row) => JSON.parse(String(row.record_json))),
      records,
    );
    const again = await f.hs.bootstrap('alice', f.bundle.id);
    assertEquals(
      again,
      records,
      'bootstrap retry preserves the complete ordered cut',
    );
    assertEquals(
      await home.query(
        "SELECT source_cut FROM facade_exports WHERE scope LIKE 'membership-export:%'",
      ),
      [{ source_cut: 1 }],
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership bootstrap scheduling: missing historical closure appends no blocked head or source cut', async () => {
  const f = await fixture();
  try {
    const operation = await source(f, 1, 'home');
    const home = await f.home.server();
    await home.execute(
      'UPDATE domain_operations SET context_json=? WHERE operation_id=?',
      [
        canonicalJson([{
          source: 'retired',
          incarnation: 'missing',
          sequence: 1,
        }]),
        operation.operationId,
      ],
    );
    await assertRejects(() => f.hs.bootstrap('alice', f.bundle.id));
    assertEquals(
      await home.query('SELECT * FROM facade_records WHERE stream=?', [
        operation.stream,
      ]),
      [],
    );
    assertEquals(
      await home.query(
        "SELECT * FROM facade_exports WHERE scope LIKE 'membership-export:%'",
      ),
      [],
    );
    assertEquals(await home.query('SELECT * FROM membership_operations'), []);
  } finally {
    await f.close();
  }
});

Deno.test('membership bootstrap scheduling: transitive old history is ordered after opposite arrival and cold reopen', async () => {
  const f = await fixture();
  try {
    const successor = await source(f, 1, 'home');
    const home = await f.home.server();
    const predecessor = {
      ...successor,
      source: 'z-retired',
      incarnation: 'old-z',
    };
    predecessor.operationId = canonicalJson([
      predecessor.source,
      predecessor.incarnation,
      predecessor.stream,
      predecessor.sequence,
    ]);
    const middle = {
      ...successor,
      source: 'a-retired',
      incarnation: 'old-a',
      context: [{
        source: predecessor.source,
        incarnation: predecessor.incarnation,
        sequence: predecessor.sequence,
      }],
    };
    middle.operationId = canonicalJson([
      middle.source,
      middle.incarnation,
      middle.stream,
      middle.sequence,
    ]);
    successor.context = [{
      source: middle.source,
      incarnation: middle.incarnation,
      sequence: middle.sequence,
    }];
    await home.execute(
      'UPDATE domain_operations SET context_json=? WHERE operation_id=?',
      [canonicalJson(successor.context), successor.operationId],
    );
    for (const operation of [middle, predecessor]) {
      await home.tx((conn) => retainMembershipOperation(conn, operation));
    }
    const reopened = await f.reopenHome();
    const records = await reopened.owner.bootstrap('alice', f.bundle.id);
    assertEquals(
      records.map((record) =>
        (record.payload as { body: { operation: MembershipOperation } }).body
          .operation.operationId
      ),
      [predecessor.operationId, middle.operationId, successor.operationId],
    );
    assertEquals(records.map((record) => record.sequence), [1, 2, 3]);
    const again = await f.reopenHome();
    assertEquals(await again.owner.bootstrap('alice', f.bundle.id), records);
    const db = await again.home.server();
    assertEquals(
      await db.query(
        'SELECT source,applied FROM domain_operations ORDER BY source',
      ),
      [
        { source: 'a-retired', applied: 0 },
        { source: 'home', applied: 1 },
        { source: 'z-retired', applied: 0 },
      ],
    );
    assertEquals(await db.query('SELECT * FROM membership_operations'), []);
    assertEquals(await db.query('SELECT * FROM prejoin_memberships'), []);
  } finally {
    await f.close();
  }
});

Deno.test('membership export scheduling: ordinary export cannot bypass historical bootstrap and append its blocked successor first', async () => {
  const f = await fixture();
  try {
    const original = await source(f, 1, 'edge');
    const predecessor = { ...original, source: 'retired', incarnation: 'old' };
    predecessor.operationId = canonicalJson([
      predecessor.source,
      predecessor.incarnation,
      predecessor.stream,
      predecessor.sequence,
    ]);
    const home = await f.home.server();
    await home.tx((conn) => retainMembershipOperation(conn, predecessor));
    const successor = await source(f, 1, 'home');
    successor.context = [{
      source: predecessor.source,
      incarnation: predecessor.incarnation,
      sequence: predecessor.sequence,
    }];
    await home.execute(
      'UPDATE domain_operations SET context_json=? WHERE operation_id=?',
      [canonicalJson(successor.context), successor.operationId],
    );
    await assertRejects(() => f.hs.export('alice', f.bundle.id));
    assertEquals(
      await home.query('SELECT * FROM facade_records WHERE stream=?', [
        successor.stream,
      ]),
      [],
    );
    assertEquals(
      await home.query(
        "SELECT * FROM facade_exports WHERE scope LIKE 'membership-export:%'",
      ),
      [],
    );
    const records = await f.hs.bootstrap('alice', f.bundle.id);
    assertEquals(
      records.map((record) =>
        (record.payload as { body: { operation: MembershipOperation } }).body
          .operation.operationId
      ),
      [predecessor.operationId, successor.operationId],
    );
    assertEquals(await f.hs.export('alice', f.bundle.id), []);
  } finally {
    await f.close();
  }
});

Deno.test('membership export scheduling: the current peer already owns its own retained predecessor without a historical echo', async () => {
  const f = await fixture();
  try {
    const predecessor = await source(f, 1, 'edge');
    const home = await f.home.server();
    await home.tx((conn) => retainMembershipOperation(conn, predecessor));
    const successor = await source(f, 1, 'home');
    successor.context = [{
      source: predecessor.source,
      incarnation: predecessor.incarnation,
      sequence: predecessor.sequence,
    }];
    await home.execute(
      'UPDATE domain_operations SET context_json=? WHERE operation_id=?',
      [canonicalJson(successor.context), successor.operationId],
    );
    const records = await f.hs.export('alice', f.bundle.id);
    assertEquals(records.length, 1);
    const body = (records[0].payload as {
      body: { kind: string; operation: MembershipOperation };
    }).body;
    assertEquals(body.kind, 'membership-operation');
    assertEquals(body.operation, successor);
    assertEquals(await f.hs.export('alice', f.bundle.id), []);
  } finally {
    await f.close();
  }
});

Deno.test('membership history: old incarnations are retained only under exact current home attestation', async (t) => {
  for (
    const change of [
      'accepted',
      'ordinary',
      'facade',
      'signature',
      'retired',
      'unselected',
    ] as const
  ) {
    await t.step(change, async () => {
      const f = await fixture();
      try {
        const { keys, operation, state } = await incoming(f, 'home');
        operation.source = 'retired_node';
        operation.incarnation = 'old-incarnation';
        operation.operationId = canonicalJson([
          operation.source,
          operation.incarnation,
          operation.stream,
          operation.sequence,
        ]);
        await (await f.home.server()).tx((conn) =>
          retainMembershipOperation(conn, operation)
        );
        const records = await f.hs.bootstrap('alice', f.bundle.id);
        const history = records.find((record) =>
          (record.payload as { body: { kind: string } }).body.kind ===
            'membership-history'
        );
        assert(history);
        const signed = history.payload as {
          body: Record<string, unknown>;
          signature: string;
        };
        if (change === 'accepted') {
          assertEquals(await f.es.retain(history, keys), state);
          const saved = await (await f.edge.server()).tx((conn) =>
            membershipHistory(conn, operation.semanticKey)
          );
          assert(
            saved.ready.some((row) =>
              canonicalJson(row) === canonicalJson(operation)
            ),
          );
          return;
        }
        if (change === 'ordinary') signed.body.kind = 'membership-operation';
        if (change === 'facade') {
          signed.body.source = f.node.node;
          signed.body.incarnation = f.node.incarnation;
          history.source = f.node.node;
          history.incarnation = f.node.incarnation;
        }
        if (change === 'signature') signed.signature = 'A'.repeat(86);
        if (change === 'ordinary' || change === 'facade') {
          signed.signature =
            await (change === 'facade' ? f.node.signer() : f.ht.signer()).sign(
              canonicalJson(signed.body),
            );
          history.operationId =
            (change === 'ordinary' ? 'membership:' : 'membership-history:') +
            createHash('sha256').update(canonicalJson([
              signed.body.pairing,
              signed.body.grantRevision,
              signed.body.ownerRevision,
              operation.operationId,
            ])).digest('hex');
        }
        if (change === 'retired') {
          await f.fp.retire(await f.hp.revoke(f.bundle.id), 'a'.repeat(64));
        }
        if (change === 'unselected') {
          await (await f.edge.server()).execute(
            "DELETE FROM facade_scopes WHERE scope='auth:@alice:logical.test'",
          );
        }
        await assertRejects(() =>
          (change === 'facade' ? f.hs : f.es).retain(history, keys, f.bundle.id)
        );
        const db = await f.edge.server();
        assertEquals(
          await db.query(
            "SELECT * FROM domain_operations WHERE kind='membership'",
          ),
          [],
        );
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('membership history: facade cannot declare bootstrap and home cannot export another account history', async () => {
  const f = await fixture();
  try {
    await source(f);
    await assertRejects(() => f.es.bootstrap('alice', f.bundle.id));
    await assertRejects(() => f.hs.bootstrap('bob', f.bundle.id));
    assertEquals(
      await (await f.home.server()).query(
        "SELECT * FROM facade_records WHERE stream LIKE 'membership:%'",
      ),
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership history: source retirement during home attestation cannot append evidence or mark it applied', async () => {
  const f = await fixture();
  try {
    const { record, keys } = await incoming(f);
    await f.hs.retain(record, keys, f.bundle.id);
    const signer = f.ht.signer();
    let signed = false;
    f.ht.signer = () => ({
      ...signer,
      sign: async (bytes: string) => {
        const signature = await signer.sign(bytes);
        signed = true;
        await f.hp.revoke(f.bundle.id);
        return signature;
      },
    });
    await assertRejects(() => f.hs.bootstrap('alice', f.bundle.id));
    assertEquals(signed, true);
    assertEquals(
      await (await f.home.server()).query(
        "SELECT * FROM facade_records WHERE stream LIKE 'membership:%'",
      ),
      [],
    );
    assertEquals(
      await (await f.home.server()).query(
        "SELECT applied FROM domain_operations WHERE kind='membership'",
      ),
      [{ applied: 0 }],
    );
  } finally {
    await f.close();
  }
});

Deno.test('membership history: attestation does not bypass actual PDU verification or account binding', async (t) => {
  for (const change of ['pdu', 'account', 'payload'] as const) {
    await t.step(change, async () => {
      const f = await fixture();
      try {
        const { record, keys } = await incoming(f);
        await f.hs.retain(record, keys, f.bundle.id);
        const [history] = await f.hs.bootstrap('alice', f.bundle.id);
        await (await f.edge.server()).execute(
          "DELETE FROM domain_operations WHERE kind='membership'",
        );
        const signed = history.payload as {
          body: { localpart: string; operation: MembershipOperation };
          signature: string;
        };
        if (change === 'account') signed.body.localpart = 'bob';
        else if (change === 'payload') {
          signed.body.operation.payload = signed.body.operation.payload.replace(
            'remote.test',
            'forged.test',
          );
        } else {
          const state = JSON.parse(signed.body.operation.payload);
          const pdu = JSON.parse(state.eventJson);
          pdu.signatures['remote.test']['ed25519:test'] = 'A'.repeat(86);
          state.eventJson = canonicalJson(pdu);
          signed.body.operation.payload = canonicalJson(state);
          signed.body.operation.payloadHash = createHash('sha256').update(
            signed.body.operation.payload,
          ).digest('hex');
        }
        signed.signature = await f.ht.signer().sign(canonicalJson(signed.body));
        await assertRejects(() => f.es.retain(history, keys));
        // A fresh receiver cannot admit forged history; immutable collision
        // rejection cannot accidentally stand in for actual PDU verification.
        assertEquals(
          await (await f.edge.server()).query(
            "SELECT * FROM domain_operations WHERE kind='membership'",
          ),
          [],
        );
        assertEquals(
          await (await f.edge.server()).query(
            'SELECT * FROM prejoin_memberships',
          ),
          [],
        );
      } finally {
        await f.close();
      }
    });
  }
});
