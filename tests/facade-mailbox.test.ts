import { assert, assertEquals, assertRejects } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { canonicalJson } from '#engine/canonical.ts';
import {
  type IngressObligation,
  Mailbox,
  verifyIngressRequest,
} from '#engine/facade/mailbox.ts';
import { initializeNode } from '#engine/facade/identity.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { Journal } from '#engine/facade/journal.ts';
import { LINK_CAPABILITIES } from '#engine/facade/protocol.ts';
import { keyStore } from '#engine/federation/keys.ts';
import { captureRequestEvidence } from '#engine/federation/request-evidence.ts';
import { requestCanonical } from '#engine/federation/request-signature.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import type { Conn, Database } from '#engine/store/db.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { signJson } from '#engine/signing-primitives.js';
import { directOnly, makeDoc } from './federation/doc-helper.ts';
import { HomeIngress } from '#engine/facade/drain.ts';
import { exportRoomReplica } from '#engine/facade/replication.ts';
import { eduState } from '#engine/federation/edus.ts';
import { registerToDevice } from '#engine/federation/todevice.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { testRemoteServer } from './fixtures/signer.ts';
import { receiveTransactionRoom } from '#engine/federation/transactions.ts';
import {
  acceptRescind,
  inviteFor,
  receiveInvite,
} from '#engine/federation/invites.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { genesis } from './fixtures/genesis.ts';
import { authAt } from './fixtures/auth.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
  wireOf,
} from './fixtures/remote.ts';

installServerHooks();

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-mailbox-' });
  const open = (name: string) =>
    openStore({
      dir: dir + '/' + name,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, {
      schemas: { server: serverSchema, room: roomSchema, tenant: tenantSchema },
    });
  let home = await open('home');
  let edge = await open('edge');
  const g = await genesis(edge, {
    roomId: '!mailbox:test',
    joinRule: 'public',
  });
  const self = g.signer.serverName;
  const tenant = await openTenant(home, self, { create: true });
  const node = await initializeNode(await edge.server(), self, 'edge_a');
  const hp = new Pairings(
    await home.server(),
    tenant.signer(),
    tenant.publicB64,
    'a'.repeat(64),
  );
  const pairings = async () =>
    new Pairings(
      await edge.server(),
      node.signer(),
      node.publicKey,
      'b'.repeat(64),
      node,
    );
  const fp = await pairings();
  const bundle = await hp.create({
    node: node.node,
    url: 'https://facade.test',
    facadePin: 'b'.repeat(64),
    expires: Date.now() + 60000,
    required: [...LINK_CAPABILITIES],
  });
  await fp.accept(bundle);
  const grant = await hp.grant(
    bundle.id,
    await fp.challenge(bundle.id, bundle.secret, 'a'.repeat(64)),
  );
  await hp.confirm(
    bundle.id,
    await fp.complete(bundle.id, grant, 'a'.repeat(64)),
  );
  const remote = await makeRemoteServer('remote.test');
  const doc = await makeDoc(remote);
  let accepted = 0;
  let fail: ((sql: string, args: readonly unknown[]) => boolean) | undefined;
  let blocked = false;
  const absent = new Set<string>();
  const db = async (): Promise<Database> => {
    const real = await edge.server();
    return {
      ...real,
      tx: (fn, options) =>
        real.tx((conn) =>
          fn(
            new Proxy(conn, {
              get(target, prop) {
                if (prop === 'execute') {
                  return (sql: string, args: readonly unknown[] = []) => {
                    if (fail?.(sql, args)) {
                      fail = undefined;
                      throw new Error('injected commit interruption');
                    }
                    return conn.execute(
                      sql,
                      args as Parameters<Conn['execute']>[1],
                    );
                  };
                }
                const value = Reflect.get(target, prop);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ), options),
    };
  };
  const mailbox = async () =>
    new Mailbox(await db(), {
      self,
      node,
      pairings: await pairings(),
      transaction: {
        self,
        store: edge,
        keys: fakeKeyResolver(remote),
        fetcher: fakeFetcher({}).fetcher,
        edus: { dispatch: () => Promise.resolve() },
      },
      scopeState: (scope) =>
        blocked
          ? Promise.reject(
            new MatrixError(503, 'M_UNAVAILABLE', 'scope not ready'),
          )
          : absent.has(scope)
          ? Promise.resolve('absent')
          : Promise.resolve('ready'),
      acceptEdu: () => {
        accepted++;
        return Promise.resolve({ kind: 'retained' });
      },
      changed() {},
    });
  const evidence = async (
    txnId: string,
    pdus: Pdu[] = [],
    edus: unknown[] = [{
      edu_type: 'm.direct_to_device',
      content: { test: true },
    }],
    timestamp = 1,
  ) => {
    const req = {
      method: 'PUT',
      uri: '/_matrix/federation/v1/send/' + encodeURIComponent(txnId) +
        '?original=yes',
      authorization: '',
      body: new TextEncoder().encode(
        JSON.stringify(
          { origin: remote.name, origin_server_ts: timestamp, pdus, edus },
          null,
          1,
        ),
      ),
    };
    const signed = JSON.parse(requestCanonical(self, req, remote.name));
    await signJson(signed, remote.name, remote.keyId, remote.kp.privateKey);
    req.authorization =
      `X-Matrix origin="${remote.name}",destination="${self}",key="${remote.keyId}",sig="${
        signed.signatures[remote.name][remote.keyId]
      }"`;
    const keys = keyStore(await edge.server(), { deps: directOnly(doc) });
    const publicKey = await keys.getVerifyKey(
      remote.name,
      remote.keyId,
      Date.now(),
      'request',
    );
    return await captureRequestEvidence(keys, self, req, {
      origin: remote.name,
      keyId: remote.keyId,
      publicKey,
    });
  };
  return {
    home: () => home,
    bundle,
    tenant,
    async homePairings() {
      return new Pairings(
        await home.server(),
        tenant.signer(),
        tenant.publicB64,
        'a'.repeat(64),
      );
    },
    async reopenHome() {
      await home.close();
      home = await open('home');
    },
    self,
    remote,
    g,
    node,
    mailbox,
    evidence,
    edge: () => edge,
    accepted: () => accepted,
    block(value: boolean) {
      blocked = value;
    },
    absent(roomId: string) {
      absent.add('room:' + roomId);
    },
    fail(match: NonNullable<typeof fail>) {
      fail = match;
    },
    async reopen() {
      await edge.close();
      edge = await open('edge');
    },
    async close() {
      await edge.close();
      await home.close();
      await Deno.remove(dir, { recursive: true });
      setConfigForTests({});
    },
    async join() {
      const sender = '@remote:' + remote.name;
      const fields = {
        type: 'm.room.member',
        sender,
        state_key: sender,
        content: { membership: 'join' },
      };
      return await remoteEvent(g.roomId, remote, '11', {
        ...fields,
        prev_events: [g.tipId],
        auth_events: await authAt(g.room, fields, g.tipId),
      });
    },
  };
}

Deno.test('mailbox commits the exact complete answer and home obligation atomically across cold retry', async () => {
  const f = await fixture();
  try {
    const proof = await f.evidence('complete');
    let box = await f.mailbox();
    await box.stage('complete', proof);
    await box.stage('complete', await f.evidence('complete'));
    f.fail((sql) => sql.startsWith('UPDATE facade_ingress SET response_json='));
    await assertRejects(
      () => box.receive(f.remote.name, 'complete'),
      MatrixError,
    );
    let server = await f.edge().server();
    assertEquals(
      await server.query(
        "SELECT * FROM facade_records WHERE stream LIKE 'ingress:%'",
      ),
      [],
    );
    assertEquals(f.accepted(), 1);
    assertEquals(
      (await server.query('SELECT response_json FROM facade_ingress'))[0]
        .response_json,
      null,
    );
    await f.reopen();
    box = await f.mailbox();
    const result = await box.receive(f.remote.name, 'complete');
    assertEquals(result, { status: 200, body: { pdus: {} } });
    assertEquals(await box.receive(f.remote.name, 'complete'), result);
    assertEquals(f.accepted(), 1);
    server = await f.edge().server();
    const [record] = await server.query(
      "SELECT record_json FROM facade_records WHERE stream LIKE 'ingress:%'",
    );
    const payload = JSON.parse(String(record.record_json))
      .payload as IngressObligation;
    assertEquals(payload.evidence, proof);
    assertEquals(payload.response, result);
    assertEquals(payload.edus, [{
      index: 0,
      disposition: { kind: 'retained' },
    }]);
    assertEquals(
      (await server.query(
        "SELECT count(*) AS n FROM facade_records WHERE stream LIKE 'ingress:%'",
      ))[0].n,
      1,
    );
    const changed = await f.evidence('complete', [], [{
      edu_type: 'changed',
      content: {},
    }]);
    assertEquals(
      (await assertRejects(() => box.stage('complete', changed), MatrixError))
        .status,
      400,
    );
    assertEquals(f.accepted(), 1);
    assertEquals(
      (await server.query(
        'SELECT count(*) AS n FROM facade_ingress_collisions',
      ))[0].n,
      1,
    );
  } finally {
    await f.close();
  }
});

Deno.test('mailbox retimestamped retries keep original evidence and exact results before and after cold completion', async () => {
  const f = await fixture();
  try {
    let box = await f.mailbox();
    const original = await f.evidence('retimestamp');
    await box.stage('retimestamp', original);
    // A legitimately re-signed envelope is the same operation even while its
    // result is pending. Timestamp changes without a new signature still fail.
    await box.stage(
      'retimestamp',
      await f.evidence('retimestamp', [], undefined, 2),
    );
    const first = await box.receive(f.remote.name, 'retimestamp');
    assertEquals(f.accepted(), 1);
    await f.reopen();
    box = await f.mailbox();
    setConfigForTests({ facade: { mailboxmaxbytes: 1 } });
    await box.stage(
      'retimestamp',
      await f.evidence('retimestamp', [], undefined, 3),
    );
    assertEquals(await box.receive(f.remote.name, 'retimestamp'), first);
    assertEquals(f.accepted(), 1);
    const db = await f.edge().server();
    const [held] = await db.query('SELECT * FROM facade_ingress');
    assertEquals(JSON.parse(String(held.evidence_json)), original);
    assertEquals(
      JSON.parse(String(held.response_json)),
      first,
    );
    assertEquals(
      await db.query('SELECT * FROM facade_ingress_collisions'),
      [],
    );
    setConfigForTests({});
    const forged = structuredClone(original);
    const body = JSON.parse(atob(forged.request.body));
    body.origin_server_ts = 4;
    forged.request.body = btoa(JSON.stringify(body));
    assertEquals(
      (await assertRejects(() => box.stage('retimestamp', forged), MatrixError))
        .status,
      400,
    );
    const changed = await f.evidence('retimestamp', [], [{
      edu_type: 'm.direct_to_device',
      content: { test: false },
    }], 5);
    assertEquals(
      (await assertRejects(
        () => box.stage('retimestamp', changed),
        MatrixError,
      ))
        .status,
      400,
    );
    assertEquals(f.accepted(), 1);
  } finally {
    await f.close();
  }
});

Deno.test('home drain retimestamped original admission retains its evidence and applies a reliable tail once', async () => {
  const f = await fixture();
  try {
    const txnId = 'home-retimestamp';
    const first = await f.evidence(txnId, [], undefined, 1);
    const retained = await f.evidence(txnId, [], undefined, 2);
    const box = await f.mailbox();
    await box.stage(txnId, first);
    assertEquals(await box.receive(f.remote.name, txnId), {
      status: 200,
      body: { pdus: {} },
    });
    const verified = await verifyIngressRequest(txnId, retained, f.self);
    const db = await f.home().server();
    const encoded = canonicalJson(retained);
    // This is the already persisted full-evidence digest, not a replacement
    // digest or a new schema. A cold reader must preserve that admission.
    await db.execute(
      'INSERT INTO facade_ingress(origin,txn_id,input_hash,evidence_json,bytes,pairing,revision,source,incarnation) VALUES(?,?,?,?,?,?,?,?,?)',
      [
        f.remote.name,
        txnId,
        verified.inputHash,
        encoded,
        new TextEncoder().encode(encoded).byteLength,
        f.bundle.id,
        1,
        f.node.node,
        f.node.incarnation,
      ],
    );
    const [out] = await (await f.edge().server()).query(
      "SELECT record_json FROM facade_records WHERE stream='ingress:remote.test'",
    );
    const record = JSON.parse(String(out.record_json));
    await f.reopenHome();
    const home = await f.home().server();
    const journal = new Journal(home, LINK_CAPABILITIES);
    let delivered = 0;
    const drain = new HomeIngress(home, {
      peer: f.node.node,
      pairing: f.bundle.id,
      pairings: await f.homePairings(),
      transaction: {
        self: f.self,
        store: f.home(),
        keys: fakeKeyResolver(f.remote),
        fetcher: fakeFetcher({}).fetcher,
        edus: {
          dispatch: () => {
            delivered++;
            return Promise.resolve();
          },
        },
      },
    });
    await journal.receive(f.node.node, [record]);
    assertEquals(await drain.apply(journal, record), true);
    assertEquals(await drain.apply(journal, record), false);
    assertEquals(delivered, 1);
    const [held] = await home.query('SELECT * FROM facade_ingress');
    assertEquals(JSON.parse(String(held.evidence_json)), retained);
    assertEquals(held.input_hash, verified.inputHash);
    assertEquals(JSON.parse(String(held.response_json)), {
      kind: 'ingress',
      origin: f.remote.name,
      txnId,
      rooms: [],
      edus: [{ index: 0, kind: 'processed', type: 'm.direct_to_device' }],
    });
  } finally {
    await f.close();
  }
});

Deno.test('mailbox recovers a room commit before its child checkpoint without losing or repeating the EDU tail', async () => {
  const f = await fixture();
  try {
    const join = await f.join();
    const box = await f.mailbox();
    await box.stage('room-cut', await f.evidence('room-cut', [join]));
    f.fail((sql, args) =>
      sql.startsWith('INSERT INTO facade_ingress_children') &&
      args[2] === 'room'
    );
    await assertRejects(
      () => box.receive(f.remote.name, 'room-cut'),
      MatrixError,
    );
    const room = await openRoom(f.edge(), f.g.roomId);
    const head = await room.tx((tx) => tx.changes.head());
    assertEquals(
      (await room.tx((tx) => tx.events.getStatus(String(join.event_id))))
        ?.grounding,
      'grounded',
    );
    assertEquals(
      f.accepted(),
      1,
      'a room checkpoint fault must not suppress reliable EDU acceptance',
    );
    await f.reopen();
    const final = await (await f.mailbox()).receive(f.remote.name, 'room-cut');
    assertEquals(final.body, { pdus: { [String(join.event_id)]: {} } });
    const recovered = await openRoom(f.edge(), f.g.roomId);
    assertEquals(await recovered.tx((tx) => tx.changes.head()), head);
    assertEquals(f.accepted(), 1);
    const [record] = await (await f.edge().server()).query(
      "SELECT record_json FROM facade_records WHERE stream LIKE 'ingress:%'",
    );
    const payload = JSON.parse(String(record.record_json))
      .payload as IngressObligation;
    assert(
      payload.rooms[0].recovery!.events.some((event) =>
        event.event_id === join.event_id
      ),
    );
  } finally {
    await f.close();
  }
});

Deno.test('mailbox scope misses retain the independent EDU tail and never cache unknown-room success', async () => {
  const f = await fixture();
  try {
    const box = await f.mailbox();
    const join = await f.join();
    await box.stage('scope-cut', await f.evidence('scope-cut', [join]));
    f.block(true);
    assertEquals(
      (await assertRejects(
        () => box.receive(f.remote.name, 'scope-cut'),
        MatrixError,
      )).status,
      503,
    );
    assertEquals(f.accepted(), 1);
    assertEquals(
      (await (await f.edge().server()).query(
        'SELECT response_json FROM facade_ingress',
      ))[0].response_json,
      null,
    );
    f.block(false);
    assertEquals((await box.receive(f.remote.name, 'scope-cut')).body, {
      pdus: { [String(join.event_id)]: {} },
    });
    assertEquals(f.accepted(), 1);
  } finally {
    await f.close();
  }
});

Deno.test('mailbox confirmed absence completes independently of accepted rooms and reliable EDUs through cold home drain', async () => {
  const f = await fixture();
  try {
    const local = await genesis(f.home(), {
      roomId: f.g.roomId,
      joinRule: 'public',
    });
    await exportRoomReplica(
      f.home(),
      local.room,
      f.self,
      f.node.node,
      f.bundle.id,
    );
    const join = await f.join();
    const absentId = '!permanently-absent:test';
    f.absent(absentId);
    const unknown = await remoteEvent(absentId, f.remote, '11', {
      type: 'm.room.message',
      sender: '@remote:remote.test',
      content: { body: 'not our room' },
      prev_events: [],
      auth_events: [],
    });
    let box = await f.mailbox();
    await box.stage(
      'known-absence',
      await f.evidence('known-absence', [unknown, join]),
    );
    const response = await box.receive(f.remote.name, 'known-absence');
    assertEquals(response, {
      status: 200,
      body: {
        pdus: {
          [String(join.event_id)]: {},
          [String(unknown.event_id)]: { error: 'unknown room' },
        },
      },
    });
    assertEquals(f.accepted(), 1);
    await f.reopen();
    box = await f.mailbox();
    assertEquals(await box.receive(f.remote.name, 'known-absence'), response);
    const [out] = await (await f.edge().server()).query(
      "SELECT record_json FROM facade_records WHERE stream='ingress:remote.test'",
    );
    const record = JSON.parse(String(out.record_json));
    let delivered = 0;
    const db = await f.home().server();
    const journal = new Journal(db, LINK_CAPABILITIES);
    const drain = new HomeIngress(db, {
      peer: f.node.node,
      pairing: f.bundle.id,
      pairings: await f.homePairings(),
      transaction: {
        self: f.self,
        store: f.home(),
        keys: fakeKeyResolver(f.remote),
        fetcher: fakeFetcher({}).fetcher,
        edus: {
          dispatch() {
            delivered++;
            return Promise.resolve();
          },
        },
      },
    });
    await journal.receive(f.node.node, [record]);
    assertEquals(await drain.apply(journal, record), true);
    assertEquals(await drain.apply(journal, record), false);
    assertEquals(delivered, 1);
    assertEquals(
      (await local.room.tx((tx) => tx.events.getStatus(String(join.event_id))))
        ?.standing,
      'accepted',
    );
    await assertRejects(
      () => openRoom(f.home(), absentId),
      Deno.errors.NotFound,
    );
    const [child] = await db.query(
      "SELECT result_json FROM facade_ingress_children WHERE kind='room' AND child_key=?",
      [absentId],
    );
    assertEquals(JSON.parse(String(child.result_json)), {
      roomId: absentId,
      result: { [String(unknown.event_id)]: { error: 'unknown room' } },
    });
    assertEquals(
      (await journal.heads(f.node.node, 'in', record)).applied.sequence,
      1,
    );
  } finally {
    await f.close();
  }
});

Deno.test('absent-room home drain preserves home-only invite rescinds without facade invite authority', async () => {
  const f = await fixture();
  try {
    const target = '@target:' + f.self;
    await registerUser(f.tenant, {
      localpart: 'target',
      password: 'pw',
      deviceId: 'PHONE',
    });
    const db = await f.home().server();
    const invites = {
      store: f.home(),
      server: db,
      signer: f.tenant.signer(),
      keys: fakeKeyResolver(f.remote),
      self: f.self,
      wake() {},
    };
    const withdrawals = [];
    for (const membership of ['leave', 'ban', 'third-party']) {
      const roomId = `!home-only-${membership}:remote.test`;
      f.absent(roomId);
      const invite = await remoteEvent(roomId, f.remote, '11', {
        type: 'm.room.member',
        sender: '@remote:remote.test',
        state_key: target,
        content: { membership: 'invite' },
        prev_events: [],
        auth_events: [],
      });
      await receiveInvite(
        roomId,
        String(invite.event_id),
        {
          room_version: '11',
          event: wireOf(invite),
          invite_room_state: [],
        },
        f.remote.name,
        invites,
      );
      const pdu = await remoteEvent(roomId, f.remote, '11', {
        type: 'm.room.member',
        sender: membership === 'third-party'
          ? '@third-party:remote.test'
          : '@remote:remote.test',
        state_key: target,
        content: { membership: membership === 'ban' ? 'ban' : 'leave' },
        prev_events: [String(invite.event_id)],
        auth_events: [],
      });
      withdrawals.push({ roomId, membership, pdu });
    }
    const box = await f.mailbox();
    await box.stage(
      'home-only-invites',
      await f.evidence(
        'home-only-invites',
        withdrawals.map(({ pdu }) => pdu),
      ),
    );
    const response = await box.receive(f.remote.name, 'home-only-invites');
    assertEquals(response, {
      status: 200,
      body: {
        pdus: Object.fromEntries(withdrawals.map(({ pdu }) => [
          String(pdu.event_id),
          { error: 'unknown room' },
        ])),
      },
    });
    const [out] = await (await f.edge().server()).query(
      "SELECT record_json FROM facade_records WHERE stream='ingress:remote.test'",
    );
    const record = JSON.parse(String(out.record_json));
    let delivered = 0;
    const journal = new Journal(db, LINK_CAPABILITIES);
    const drain = new HomeIngress(db, {
      peer: f.node.node,
      pairing: f.bundle.id,
      pairings: await f.homePairings(),
      transaction: {
        self: f.self,
        store: f.home(),
        keys: fakeKeyResolver(f.remote),
        fetcher: fakeFetcher({}).fetcher,
        rescind: (roomId, pdu) => acceptRescind(roomId, pdu, invites),
        edus: {
          dispatch: () => {
            delivered++;
            return Promise.resolve();
          },
        },
      },
    });
    await journal.receive(f.node.node, [record]);
    assertEquals(await drain.apply(journal, record), true);
    const revisions = [];
    for (const { roomId, membership, pdu } of withdrawals) {
      const held = await inviteFor(roomId, target, invites);
      assertEquals(
        held?.status,
        membership === 'third-party' ? 'pending' : 'rejected',
      );
      if (membership !== 'third-party') {
        assertEquals(JSON.parse(held!.eventJson).event_id, pdu.event_id);
      }
      revisions.push(held?.revision);
      await assertRejects(
        () => openRoom(f.home(), roomId),
        Deno.errors.NotFound,
      );
      const [child] = await db.query(
        "SELECT result_json FROM facade_ingress_children WHERE kind='room' AND child_key=?",
        [roomId],
      );
      assertEquals(JSON.parse(String(child.result_json)).result, {
        [String(pdu.event_id)]: membership === 'third-party'
          ? { error: 'unknown room' }
          : {},
      });
    }
    assertEquals(await drain.apply(journal, record), false);
    assertEquals(delivered, 1);
    assertEquals(
      await box.receive(f.remote.name, 'home-only-invites'),
      response,
    );
    assertEquals(
      await Promise.all(
        withdrawals.map(async ({ roomId }) =>
          (await inviteFor(roomId, target, invites))?.revision
        ),
      ),
      revisions,
    );
  } finally {
    await f.close();
  }
});

Deno.test('mailbox configured capacity refuses only new work and journal ACK releases admission accounting without eviction', async () => {
  const f = await fixture();
  try {
    const box = await f.mailbox();
    const proof = await f.evidence('capacity');
    f.fail((sql) => sql.startsWith('INSERT INTO facade_ingress('));
    assertEquals(
      (await assertRejects(() => box.stage('capacity', proof), MatrixError))
        .status,
      503,
    );
    assertEquals(
      await (await f.edge().server()).query('SELECT * FROM facade_ingress'),
      [],
    );
    setConfigForTests({ facade: { mailboxmaxbytes: 1 } });
    assertEquals(
      (await assertRejects(() => box.stage('capacity', proof), MatrixError))
        .status,
      429,
    );
    setConfigForTests({ facade: { mailboxmaxbytes: 0 } });
    await box.stage('capacity', proof);
    const concurrent = await Promise.all([
      box.receive(f.remote.name, 'capacity'),
      box.receive(f.remote.name, 'capacity'),
    ]);
    assertEquals(concurrent[0], concurrent[1]);
    assertEquals(f.accepted(), 1);
    setConfigForTests({ facade: { mailboxmaxbytes: 1 } });
    await box.stage('capacity', proof);
    const server = await f.edge().server();
    const next = await f.evidence('capacity-next');
    setConfigForTests({
      facade: {
        mailboxmaxbytes: Math.max(
          Number(
            (await server.query('SELECT bytes FROM facade_ingress'))[0].bytes,
          ),
          new TextEncoder().encode(canonicalJson(next)).byteLength,
        ),
      },
    });
    assertEquals(
      (await assertRejects(() => box.stage('capacity-next', next), MatrixError))
        .status,
      429,
    );
    const journal = new Journal(server, LINK_CAPABILITIES);
    const [stream] = await journal.streams('home', 'out');
    const record = (await journal.page('home', 'out', stream, 0, {
      maxItems: 1,
      maxBytes: 1,
    })).records[0];
    const cut = { sequence: record.sequence, hash: record.hash };
    await journal.ack('home', stream, cut, cut, [{
      ...cut,
      result: { accepted: true },
    }]);
    await box.stage('capacity-next', next);
    assertEquals(
      (await server.query('SELECT count(*) AS n FROM facade_ingress'))[0].n,
      2,
    );
    assertEquals(
      (await server.query('SELECT count(*) AS n FROM facade_records'))[0].n,
      1,
    );
  } finally {
    await f.close();
  }
});

Deno.test('mailbox capacity accounts for distinct collision evidence without charging duplicate retries', async () => {
  const f = await fixture();
  try {
    const box = await f.mailbox();
    const original = await f.evidence('collision-limit');
    await box.stage('collision-limit', original);
    const variant = (value: string) =>
      f.evidence('collision-limit', [], [{
        edu_type: 'm.test',
        content: { value },
      }]);
    const one = await variant('one');
    const bytes = (value: unknown) =>
      new TextEncoder().encode(canonicalJson(value)).byteLength;
    setConfigForTests({
      facade: { mailboxmaxbytes: bytes(original) + bytes(one) },
    });
    assertEquals(
      (await assertRejects(
        () => box.stage('collision-limit', one),
        MatrixError,
      )).status,
      400,
    );
    assertEquals(
      (await assertRejects(
        () => box.stage('collision-limit', one),
        MatrixError,
      )).status,
      400,
    );
    const two = await variant('two');
    assertEquals(
      (await assertRejects(
        () => box.stage('collision-limit', two),
        MatrixError,
      )).status,
      429,
    );
    const fresh = await f.evidence('new-after-collision');
    setConfigForTests({
      facade: { mailboxmaxbytes: bytes(original) + bytes(fresh) },
    });
    assertEquals(
      (await assertRejects(
        () => box.stage('new-after-collision', fresh),
        MatrixError,
      )).status,
      429,
    );
    assertEquals(
      (await (await f.edge().server()).query(
        'SELECT count(*) AS n FROM facade_ingress_collisions',
      ))[0].n,
      1,
    );
    setConfigForTests({ facade: { mailboxmaxbytes: 1 } });
    await box.stage('collision-limit', original);
    assertEquals(
      (await assertRejects(
        () => box.stage('collision-limit', one),
        MatrixError,
      )).status,
      400,
    );
  } finally {
    await f.close();
  }
});

Deno.test('mailbox schema upgrades v33 without recreating identity or pairing', async () => {
  const f = await fixture();
  try {
    const server = await f.edge().server();
    await server.tx(async (conn) => {
      await conn.exec(
        'DROP TABLE facade_egress_routes; DROP TABLE facade_egress; DROP TABLE facade_ingress_collisions; DROP TABLE facade_ingress_children; DROP TABLE facade_ingress',
      );
      await conn.execute("UPDATE meta SET v='33' WHERE k='schema_version'");
    }, { mode: 'deferred' });
    await f.reopen();
    const box = await f.mailbox();
    await box.stage('upgraded', await f.evidence('upgraded'));
    assertEquals((await box.receive(f.remote.name, 'upgraded')).status, 200);
    assertEquals(
      (await (await f.edge().server()).query(
        "SELECT v FROM meta WHERE k='schema_version'",
      ))[0].v,
      String(serverSchema.version),
    );
  } finally {
    await f.close();
  }
});

Deno.test('home drain reconciles room and reliable EDU commits across child and final-result crash cuts before ACK', async () => {
  for (const cut of ['room', 'edu', 'final']) {
    const f = await fixture();
    try {
      const local = await genesis(f.home(), {
        roomId: f.g.roomId,
        joinRule: 'public',
      });
      assertEquals(local.tipId, f.g.tipId);
      await exportRoomReplica(
        f.home(),
        local.room,
        f.self,
        f.node.node,
        f.bundle.id,
      );
      await registerUser(f.tenant, {
        localpart: 'target',
        password: 'pw',
        deviceId: 'PHONE',
      });
      const join = await f.join();
      await receiveTransactionRoom(f.g.roomId, [join], f.remote.name, {
        store: f.edge(),
        self: f.self,
        keys: fakeKeyResolver(f.remote),
        fetcher: fakeFetcher({}).fetcher,
        edus: { dispatch: () => Promise.resolve() },
      });
      const fields = {
        type: 'm.room.message',
        sender: '@remote:remote.test',
        content: { body: 'retained branch' },
      };
      const message = await remoteEvent(f.g.roomId, f.remote, '11', {
        ...fields,
        prev_events: [String(join.event_id)],
        auth_events: await authAt(f.g.room, fields, String(join.event_id)),
        depth: 100,
      });
      const lan = await sendLocal(local.room, {
        type: 'm.room.message',
        sender: local.creator,
        content: { body: 'concurrent LAN branch' },
        origin_server_ts: Date.now(),
      }, local.signer);
      const edus = [{
        edu_type: 'm.direct_to_device',
        content: {
          sender: '@remote:remote.test',
          type: 'm.test',
          message_id: 'home-' + cut,
          messages: { ['@target:' + f.self]: { '*': { cut } } },
        },
      }, { edu_type: 'm.typing', content: {} }];
      const box = await f.mailbox();
      await box.stage(
        'home-' + cut,
        await f.evidence('home-' + cut, [message], edus),
      );
      await box.receive(f.remote.name, 'home-' + cut);
      const [out] = await (await f.edge().server()).query(
        "SELECT record_json FROM facade_records WHERE stream='ingress:remote.test'",
      );
      const record = JSON.parse(String(out.record_json));
      let fail = true;
      const setup = async () => {
        const real = await f.home().server();
        const db: Database = {
          ...real,
          tx: (fn, options) =>
            real.tx((conn) =>
              fn(
                new Proxy(conn, {
                  get(target, prop) {
                    if (prop === 'execute') {
                      return (sql: string, args: readonly unknown[] = []) => {
                        if (
                          fail &&
                          ((cut === 'final' &&
                            sql.startsWith(
                              'UPDATE facade_ingress SET response_json=',
                            )) ||
                            (sql.startsWith(
                              'INSERT INTO facade_ingress_children',
                            ) && args[2] === cut))
                        ) {
                          fail = false;
                          throw new Error(
                            'injected home ' + cut + ' checkpoint interruption',
                          );
                        }
                        return conn.execute(
                          sql,
                          args as Parameters<Conn['execute']>[1],
                        );
                      };
                    }
                    const value = Reflect.get(target, prop);
                    return typeof value === 'function'
                      ? value.bind(target)
                      : value;
                  },
                }),
              ), options),
        };
        const tenant = await openTenant(f.home(), f.self);
        const edus = eduState(real, f.self, f.home());
        registerToDevice(edus, tenant);
        const journal = new Journal(db, LINK_CAPABILITIES);
        const drain = new HomeIngress(db, {
          peer: f.node.node,
          pairing: f.bundle.id,
          pairings: await f.homePairings(),
          transaction: {
            self: f.self,
            store: f.home(),
            keys: fakeKeyResolver(f.remote, await testRemoteServer()),
            fetcher: fakeFetcher({}).fetcher,
            edus,
          },
        });
        return { journal, drain };
      };
      let { journal, drain } = await setup();
      await journal.receive(f.node.node, [record]);
      await assertRejects(
        () => drain.apply(journal, record),
        Error,
        'injected home',
      );
      assertEquals(
        (await journal.heads(f.node.node, 'in', record)).applied.sequence,
        0,
      );
      const room = await openRoom(f.home(), f.g.roomId);
      const head = await room.tx((tx) => tx.changes.head());
      assertEquals(
        (await room.tx((tx) => tx.events.getStatus(String(message.event_id))))
          ?.standing,
        'accepted',
      );
      const rows = await (await f.home().tenant(f.self)).query(
        'SELECT event_json FROM to_device_inbox',
      );
      assertEquals(rows.length, 1);
      await f.reopenHome();
      ({ journal, drain } = await setup());
      assert(await drain.apply(journal, record));
      assertEquals(await drain.apply(journal, record), false);
      const reopened = await openRoom(f.home(), f.g.roomId);
      assertEquals(await reopened.tx((tx) => tx.changes.head()), head);
      for (
        const id of [
          String(join.event_id),
          String(message.event_id),
          lan.eventId,
        ]
      ) {
        assertEquals(
          (await reopened.tx((tx) => tx.events.getStatus(id)))?.standing,
          'accepted',
        );
        assert(await reopened.tx((tx) => tx.segments.positionOf(id)));
      }
      assertEquals(
        await (await f.home().tenant(f.self)).query(
          'SELECT event_json FROM to_device_inbox',
        ),
        rows,
      );
      assertEquals(
        (await journal.heads(f.node.node, 'in', record)).applied.sequence,
        1,
      );
      const ack = await journal.acknowledgement(f.node.node, record, {
        sequence: 0,
        hash: '',
      }, { maxItems: 100, maxBytes: 100000 });
      await new Journal(await f.edge().server(), LINK_CAPABILITIES).ack(
        'home',
        record,
        ack.received,
        ack.applied,
        ack.results,
      );
      assertEquals(
        (await (await f.edge().server()).query(
          "SELECT result_json FROM facade_records WHERE stream='ingress:remote.test'",
        ))[0].result_json !== null,
        true,
      );
    } finally {
      await f.close();
    }
  }
});
