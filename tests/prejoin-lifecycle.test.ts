import { assert, assertEquals, assertRejects } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import { createHash } from 'node:crypto';
import { setConfigForTests } from '#engine/config.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import {
  type InviteDeps,
  inviteFor,
  inviteIntentProvider,
  markInviteJoined,
  prejoinDeparture,
  prepareRemoteLeave,
  pruneRejectIntents,
  receiveInvite,
  rejectInviteRemote,
  retryPrejoinIntents,
} from '#engine/federation/invites.ts';
import { knockRemote, performKnockAttempt } from '#engine/federation/knocks.ts';
import { toWire } from '#engine/federation/pdu.ts';
import { admitLocalJoin } from '#engine/room/hooks.ts';
import { roomSchema } from '#engine/room/index.ts';
import { installJoinAdmission } from '#engine/server/join-attempts.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { recordMembershipOperation } from '#engine/server/membership-operations.ts';
import { membershipOperations } from '#engine/server/membership-operations.ts';
import { bindMembershipDisplay } from '#engine/server/membership-selection.ts';
import {
  beginPrejoinJob,
  prejoinJobId,
  prejoinJobs,
  updatePrejoinJob,
} from '#engine/server/prejoin-jobs.ts';
import { verify } from '#engine/room/verify.ts';
import {
  eventStreamMax,
  eventStreamTx,
  nextEventSeq,
} from '#engine/server/stream.ts';
import { openStore } from '#engine/store/index.ts';
import { startFakeServer } from '#tests/federation/fake-server.ts';
import { createFakeRoom } from '#tests/federation/fake-room.ts';
import { fakeKeyResolver } from '#tests/fixtures/remote.ts';
import { testRemoteServer, testSigner } from '#tests/fixtures/signer.ts';
import { assertAuthored } from '#tests/fixtures/authored.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Signer } from '#engine/room/signer.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
} from '#engine/signing-primitives.js';

async function fixture(
  run: (f: {
    deps: InviteDeps;
    roomId: string;
    user: string;
    origin: string;
    publish: () => Promise<number>;
    publishInvite: () => Promise<void>;
    reject: (reason?: string) => Promise<void>;
    sentLeave: () => Pdu | null;
    knockRequests: () => number;
    sentKnocks: () => Pdu[];
    knockAnswer: (answer: () => Promise<Response>) => void;
    sent: Promise<void>;
    finish: () => void;
    reopen: () => Promise<void>;
  }) => Promise<void>,
  semanticSource: false | 'home' | 'edge' = false,
) {
  const dir = await Deno.makeTempDir();
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const schemas = { room: roomSchema, server: serverSchema };
  let store = await openStore(options, { schemas });
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  let signal!: () => void;
  let finish!: () => void;
  const sent = new Promise<void>((r) => signal = r);
  const gate = new Promise<void>((r) => finish = r);
  let room: Awaited<ReturnType<typeof createFakeRoom>>;
  let sentLeave: Pdu | null = null;
  let knockRequests = 0;
  const sentKnocks: Pdu[] = [];
  let knockAnswer = () =>
    Promise.resolve(Response.json({ knock_room_state: [] }));
  const us = await testRemoteServer('test');
  const fake = await startFakeServer({
    ourKeyDoc: async () => ({
      server_name: 'test',
      verify_keys: {
        [us.keyId]: {
          key: b64encodeStd(await exportPublicKeyRaw(us.kp.publicKey)),
        },
      },
    }),
    handlers: async (req) => {
      if (req.url.pathname.includes('/make_leave/')) {
        return Response.json(room.makeLeaveTemplate('@dev:test'));
      }
      if (req.url.pathname.includes('/send_leave/')) {
        sentLeave = req.json() as Pdu;
        signal();
        await gate;
        return Response.json({});
      }
      if (req.url.pathname.includes('/make_knock/')) {
        return Response.json({
          room_version: '11',
          event: {
            ...room.makeLeaveTemplate(
              decodeURIComponent(req.url.pathname.split('/').at(-1)!),
            ).event as Record<
              string,
              unknown
            >,
            content: { membership: 'knock' },
          },
        });
      }
      if (req.url.pathname.includes('/send_knock/')) {
        knockRequests++;
        sentKnocks.push(req.json() as Pdu);
        return await knockAnswer();
      }
      return new Response('', { status: 404 });
    },
  });
  try {
    room = await createFakeRoom({
      version: '11',
      creator: '@owner:' + fake.name,
      server: { name: fake.name, keyId: fake.keyId, kp: fake.kp },
    });
    const user = '@dev:test';
    let server = await store.server();
    if (semanticSource) {
      // Start at the already-verified per-file activation boundary. Link/control
      // signature admission has its own tests; this exercises the real OOB owner.
      await server.execute(
        "INSERT INTO publication_domain VALUES(1,?,'publication','domain')",
        [semanticSource],
      );
      await server.execute(
        'INSERT INTO facade_owner_controls VALUES(?,?,?,?)',
        [
          'membership-test',
          1,
          'verified-test',
          JSON.stringify({
            body: {
              server: 'test',
              nodes: [
                { node: 'home', incarnation: 'home-store' },
                { node: 'edge', incarnation: 'edge-store' },
              ],
            },
          }),
        ],
      );
      await server.execute(
        "INSERT INTO facade_owner_activation VALUES('membership-test',1,'verified-test')",
      );
    }
    const deps: InviteDeps = {
      store,
      server,
      signer: await testSigner(),
      keys: fakeKeyResolver(fake),
      self: 'test',
      wake: () => {},
    };
    installJoinAdmission(store);
    const invite = await room.addEvent({
      type: 'm.room.member',
      sender: '@owner:' + fake.name,
      state_key: user,
      content: { membership: 'invite' },
    });
    await receiveInvite(
      room.roomId,
      String(invite.event_id),
      { room_version: '11', event: room.wire(invite), invite_room_state: [] },
      fake.name,
      deps,
    );
    const publish = () =>
      eventStreamTx(server, async (tx) => {
        const seq = await nextEventSeq(tx);
        await tx.execute(
          "INSERT INTO memberships(room,user,membership,event,seq) VALUES(?,?,'leave','$published',?) ON CONFLICT(room,user) DO UPDATE SET membership='leave',seq=excluded.seq",
          [room.roomId, user, seq],
        );
        return seq;
      });
    // A fewer-arguments function is assignable here on the old source too,
    // so failing-first observes the dropped value rather than a type error.
    const reject: (
      room: string,
      user: string,
      deps: InviteDeps,
      reason?: string,
    ) => Promise<void> = rejectInviteRemote;
    await run({
      deps,
      roomId: room.roomId,
      user,
      origin: fake.name,
      publish,
      publishInvite: async () => {
        const newer = await room.addEvent({
          type: 'm.room.member',
          sender: '@owner:' + fake.name,
          state_key: user,
          content: { membership: 'invite', reason: 'newer invitation' },
        });
        await receiveInvite(
          room.roomId,
          String(newer.event_id),
          {
            room_version: '11',
            event: room.wire(newer),
            invite_room_state: [],
          },
          fake.name,
          deps,
        );
      },
      reject: (reason) => reject(room.roomId, user, deps, reason),
      sentLeave: () => sentLeave,
      knockRequests: () => knockRequests,
      sentKnocks: () => sentKnocks,
      knockAnswer: (answer) => knockAnswer = answer,
      sent,
      finish,
      reopen: async () => {
        await store.close();
        store = await openStore(options, { schemas });
        deps.store = store;
        deps.server = server = await store.server();
        installJoinAdmission(store);
      },
    });
  } finally {
    finish();
    await fake.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
    setConfigForTests({ federation: { cacerts: [] } });
    resetCaCertsForTests();
  }
}

// Start at the authenticated display owner's boundary, not at wire admission.
// The later invitation was authored independently during the partition, so it
// does not observe the local pending rejection or acquire its delivery job.
async function concurrentInvite(
  f: Parameters<Parameters<typeof fixture>[0]>[0],
) {
  await f.publishInvite();
  return await f.deps.server.tx(async (tx) => {
    const [latest] = await tx.query(
      "SELECT * FROM domain_operations WHERE kind='membership' AND source='edge' ORDER BY sequence DESC LIMIT 1",
    );
    assert(latest);
    const imported = canonicalJson(['home', 'home-store', latest.stream, 1]);
    await tx.execute(
      'UPDATE domain_operations SET operation_id=?,source=?,incarnation=?,sequence=1,context_json=? WHERE operation_id=?',
      [imported, 'home', 'home-store', '[]', String(latest.operation_id)],
    );
    const operations = await membershipOperations(tx, f.user);
    const selected = operations.filter((op) => op.operationId === imported);
    await bindMembershipDisplay(tx, f.roomId, f.user, selected);
    return JSON.parse(selected[0].payload).eventId as string;
  });
}

Deno.test('prejoin jobs: a held rejection stays reviewable after concurrent foreign display replacement', () =>
  fixture(async (f) => {
    await f.reject('old local work');
    const provider = inviteIntentProvider(f.deps);
    const job = await provider(f.deps.server, f.origin);
    assert(job);
    const running = job.run();
    try {
      await f.sent;
      const frozen = structuredClone(f.sentLeave());
      const selected = await concurrentInvite(f);
      assertEquals(
        (await inviteFor(f.roomId, f.user, f.deps))?.eventId,
        selected,
      );
      const reviewed = await provider.review();
      assert(
        reviewed.some((row) =>
          row.intent.what === 'reject-invite' && row.intent.user_id === f.user
        ),
        'display replacement erased the still-owned rejection job from review',
      );
      assertEquals(f.sentLeave(), frozen, 'prepared wire bytes changed');
    } finally {
      f.finish();
      await running;
    }
  }, 'edge'));

Deno.test('prejoin jobs: held completion authors only its prepared source successor, not the concurrent display', () =>
  fixture(async (f) => {
    await f.reject('old local work');
    const prior = await inviteFor(f.roomId, f.user, f.deps);
    assert(prior);
    const job = await inviteIntentProvider(f.deps)(f.deps.server, f.origin);
    assert(job);
    const running = job.run();
    let selected: string | null = null;
    try {
      await f.sent;
      selected = await concurrentInvite(f);
    } finally {
      f.finish();
      await running;
    }
    assert(selected);
    const facts = await f.deps.server.tx((tx) =>
      membershipOperations(tx, f.user)
    );
    const completed = facts.filter((op) =>
      op.source === 'edge' && JSON.parse(op.payload).status === 'rejected'
    );
    assertEquals(
      completed.length,
      1,
      'the acknowledged old job lost its completion',
    );
    assertEquals(JSON.parse(completed[0].payload).eventId, prior.eventId);
    assertEquals(
      completed[0].context.some((dot) => dot.source === 'home'),
      false,
    );
    assertEquals(
      (await inviteFor(f.roomId, f.user, f.deps))?.eventId,
      selected,
    );
    await f.reopen();
    assertEquals(
      (await inviteFor(f.roomId, f.user, f.deps))?.eventId,
      selected,
    );
  }, 'edge'));

Deno.test('prejoin jobs: make_leave prepared later follows the resident current invitation', () =>
  fixture(async (f) => {
    await f.reject('old local work');
    const prior = await inviteFor(f.roomId, f.user, f.deps);
    assert(prior?.localLeaveJson);
    const original = JSON.parse(prior.localLeaveJson) as Pdu;
    const selected = await concurrentInvite(f);
    const prepared = await prepareRemoteLeave(f.origin, prior, f.deps);
    assertEquals(original.prev_events.includes(selected), false);
    assert(
      prepared.prev_events.includes(selected),
      'ordinary make_leave uses the resident current DAG cut',
    );
    assert(
      prepared.auth_events.includes(selected),
      'current membership authorizes the fresh remote leave',
    );
    assertEquals(prepared.content.reason, 'old local work');
    assertEquals(
      (await inviteFor(f.roomId, f.user, f.deps))?.eventId,
      selected,
    );
  }, 'edge'));

Deno.test('prejoin jobs: cold reopen retains local rejection independently of concurrent foreign display', () =>
  fixture(async (f) => {
    await f.reject('durable old work');
    const selected = await concurrentInvite(f);
    await f.reopen();
    const provider = inviteIntentProvider(f.deps);
    const job = await provider(f.deps.server, f.origin);
    assert(
      job,
      'cold display replacement erased the local delivery obligation',
    );
    assertEquals(
      (await inviteFor(f.roomId, f.user, f.deps))?.eventId,
      selected,
    );
    await assertRejects(() => admitLocalJoin(f.deps.store, f.roomId, f.user));
    const running = job.run();
    try {
      await f.sent;
      assert(f.sentLeave()?.prev_events.includes(selected));
    } finally {
      f.finish();
      await running;
    }
    assertEquals(await prejoinJobs(f.deps.server), []);
    assertEquals(
      (await inviteFor(f.roomId, f.user, f.deps))?.eventId,
      selected,
    );
    await f.reopen();
    assertEquals(await prejoinJobs(f.deps.server), []);
    assertEquals(await provider(f.deps.server, f.origin), null);
  }, 'edge'));

Deno.test('prejoin jobs: expiry retry and prune retain exact old work without borrowing foreign display', () =>
  fixture(async (f) => {
    await f.reject('old owned reason');
    const selected = await concurrentInvite(f);
    const [original] = await prejoinJobs(f.deps.server);
    assert(original);
    await f.deps.server.tx((tx) =>
      updatePrejoinJob(tx, original, {
        ...original.work,
        expiresMs: Date.now() - 1,
      }, false)
    );
    const provider = inviteIntentProvider(f.deps);
    assertEquals(await provider(f.deps.server, f.origin), null);
    const [expired] = await prejoinJobs(f.deps.server);
    assertEquals(expired.id, original.id);
    assertEquals(expired.work.status, 'failed-retract');
    assertEquals((await provider.review()).length, 1);
    await retryPrejoinIntents(f.deps.store, f.deps.server, 'test', f.origin);
    const [retried] = await prejoinJobs(f.deps.server);
    assertEquals(retried.id, original.id);
    assertEquals(retried.work.eventId, original.work.eventId);
    assertEquals(retried.work.localLeaveJson, original.work.localLeaveJson);
    assertEquals(retried.work.status, 'rejecting');
    assertEquals(
      retried.source?.context.some((dot) => dot.source === 'home'),
      false,
    );
    assertEquals(
      (await inviteFor(f.roomId, f.user, f.deps))?.eventId,
      selected,
    );
    await assertRejects(() => admitLocalJoin(f.deps.store, f.roomId, f.user));
    assertEquals(
      await pruneRejectIntents(f.deps.store, f.deps.server, 'test', f.origin),
      1,
    );
    assertEquals(await prejoinJobs(f.deps.server), []);
    assertEquals(
      (await inviteFor(f.roomId, f.user, f.deps))?.eventId,
      selected,
    );
    await admitLocalJoin(f.deps.store, f.roomId, f.user);
  }, 'edge'));

Deno.test('prejoin: typed source intent retains overwritten invitation and departure across cold reopen', () =>
  fixture(async (f) => {
    const facts = async () => (await f.deps.server.query(
      "SELECT * FROM domain_operations WHERE kind='membership' ORDER BY sequence",
    ));
    const initial = await facts();
    assertEquals(
      initial.length,
      1,
      'invitation and immutable export intent commit together',
    );
    const first = JSON.parse(String(initial[0].payload_json));
    assertEquals(first.status, 'pending');
    await f.reject('retained local departure');
    const departure = await facts();
    assertEquals(departure.length, 2);
    const leave = JSON.parse(String(departure[1].payload_json));
    assertEquals(leave.status, 'rejecting');
    assertEquals(
      JSON.parse(leave.localLeaveJson).content.reason,
      'retained local departure',
    );
    await f.reject('must not replace it');
    assertEquals(
      await facts(),
      departure,
      'exact retry creates no new source identity',
    );
    await f.publishInvite();
    const retained = await facts();
    assertEquals(retained.length, 3);
    assertEquals(
      retained.slice(0, 2),
      departure,
      'later display replacement cannot erase acknowledged source facts',
    );
    const last = JSON.parse(String(retained[2].payload_json));
    assertEquals(last.status, 'pending');
    assert(last.eventId !== first.eventId);
    for (const row of retained) {
      const payload = JSON.parse(String(row.payload_json));
      assertEquals(payload.roomId, f.roomId);
      assertEquals(payload.userId, f.user);
      assertEquals(
        payload.seq,
        undefined,
        'publication numbers never become semantic authority',
      );
      assertEquals(
        payload.revision,
        undefined,
        'local lifecycle revisions never become foreign authority',
      );
    }
    await f.reopen();
    assertEquals(await facts(), retained);
    assertEquals(
      (await f.deps.store.rooms()).includes(f.roomId),
      false,
      'OOB evidence never fabricates a joined room',
    );
  }, 'home'));

Deno.test('prejoin: source intent failure rolls back lifecycle, publication and source counter', () =>
  fixture(async (f) => {
    const before = await f.deps.server.query(
      'SELECT * FROM prejoin_memberships',
    );
    const counters = await f.deps.server.query(
      'SELECT * FROM counters ORDER BY name',
    );
    const facts = await f.deps.server.query('SELECT * FROM domain_operations');
    const transact = f.deps.server.tx.bind(f.deps.server);
    f.deps.server.tx = (fn) =>
      transact((conn) =>
        fn(
          new Proxy(conn, {
            get(target, property) {
              if (property === 'execute') {
                return (...args: Parameters<typeof conn.execute>) => {
                  if (
                    args[0].startsWith('INSERT INTO domain_operations')
                  ) throw new Error('source intent storage failure');
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
        () => f.reject(),
        Error,
        'source intent storage failure',
      );
    } finally {
      f.deps.server.tx = transact;
    }
    assertEquals(
      await f.deps.server.query('SELECT * FROM prejoin_memberships'),
      before,
    );
    assertEquals(
      await f.deps.server.query('SELECT * FROM counters ORDER BY name'),
      counters,
    );
    assertEquals(
      await f.deps.server.query('SELECT * FROM domain_operations'),
      facts,
    );
    await f.reject();
    const retained = await f.deps.server.query(
      "SELECT * FROM domain_operations WHERE kind='membership' ORDER BY sequence",
    );
    assertEquals(retained.map((row) => row.source), ['edge', 'edge']);
    assertEquals(retained.map((row) => row.sequence), [1, 2]);
    const context = JSON.parse(String(retained[1].context_json));
    assertEquals(context, [{
      source: 'edge',
      incarnation: 'edge-store',
      sequence: 1,
    }]);
  }, 'edge'));

Deno.test('prejoin: semantic knock intent retains uncertain attempt, exact completion and joined retirement', () =>
  fixture(async (f) => {
    const facts = async () => (await f.deps.server.query(
      "SELECT * FROM domain_operations WHERE kind='membership' ORDER BY sequence",
    ));
    await f.publish();
    f.knockAnswer(() =>
      Promise.resolve(Response.json({ knock_room_state: null }))
    );
    await assertRejects(() =>
      knockRemote(f.roomId, f.user, {}, [f.origin], f.deps)
    );
    const pending = await facts();
    assertEquals(pending.length, 2);
    const attempt = JSON.parse(String(pending[1].payload_json));
    assertEquals(attempt.kind, 'knock');
    assertEquals(attempt.status, 'attempting');
    assertEquals<unknown>(
      toWire(JSON.parse(attempt.eventJson), attempt.roomVersion),
      f.sentKnocks()[0],
    );
    await f.reopen();
    f.knockAnswer(() =>
      Promise.resolve(Response.json({ knock_room_state: [] }))
    );
    const job = await inviteIntentProvider(f.deps)(f.deps.server, f.origin);
    assert(job);
    await job.run();
    const complete = await facts();
    assertEquals(complete.length, 3);
    const completed = JSON.parse(String(complete[2].payload_json));
    assertEquals(completed.status, 'pending');
    assertEquals(completed.eventId, attempt.eventId);
    assertEquals(f.sentKnocks()[0], f.sentKnocks()[1]);
    await markInviteJoined(f.roomId, f.user, f.deps);
    const joined = await facts();
    assertEquals(joined.length, 4);
    assertEquals(JSON.parse(String(joined[3].payload_json)).status, 'joined');
    await markInviteJoined(f.roomId, f.user, f.deps);
    assertEquals(await facts(), joined);
  }, 'edge'));

Deno.test('prejoin: a local successor never recaptures the selected foreign source fact as local intent', () =>
  fixture(async (f) => {
    await f.publishInvite();
    const facts = await f.deps.server.query(
      "SELECT * FROM domain_operations WHERE kind='membership' ORDER BY sequence",
    );
    assertEquals(facts.length, 2);
    const current = facts[1];
    // Start at a foreign operation owner's authenticated, already-materialized
    // selection boundary. This test targets local source capture, not wire trust.
    const imported = canonicalJson([
      'home',
      'home-store',
      current.stream,
      current.sequence,
    ]);
    await f.deps.server.tx(async (conn) => {
      await conn.execute(
        'UPDATE domain_operations SET operation_id=?,source=?,incarnation=?,context_json=? WHERE operation_id=?',
        [imported, 'home', 'home-store', '[]', current.operation_id as string],
      );
      await conn.execute('DELETE FROM domain_frontiers WHERE semantic_key=?', [
        current.semantic_key as string,
      ]);
      await conn.execute(
        'INSERT INTO domain_frontiers(semantic_key,operation_id) VALUES(?,?)',
        [current.semantic_key as string, imported],
      );
    });
    await f.reject();
    const after = await f.deps.server.query(
      "SELECT * FROM domain_operations WHERE kind='membership' ORDER BY sequence,source",
    );
    assertEquals(
      after.length,
      3,
      'local mutation must not copy the imported display as a new source fact',
    );
    const local = after.filter((row) => row.source === 'edge');
    assertEquals(local.length, 2);
    assertEquals(JSON.parse(String(local[1].payload_json)).status, 'rejecting');
    assert(
      JSON.parse(String(local[1].context_json)).some((
        dot: { source: string },
      ) => dot.source === 'home'),
    );
  }, 'edge'));

Deno.test('prejoin: normalized multi-source display never becomes new local authorship', () =>
  fixture(async (f) => {
    const [original] = await f.deps.server.tx((conn) =>
      membershipOperations(conn, f.user)
    );
    assert(original);
    const raw = JSON.parse(JSON.parse(original.payload).eventJson) as Pdu;
    raw.unsigned = { untrusted: true };
    // A hash mismatch is normalized by the ordinary verifier, not by selecting
    // whichever source happened to deliver a convenient raw JSON shape.
    raw.content.displayname = 'not covered by the retained hash';
    const normalized = await verify(structuredClone(raw), '11', f.deps.keys);
    assertEquals(normalized.pdu.unsigned, undefined);
    assertEquals(normalized.pdu.content.displayname, undefined);
    await f.deps.server.tx(async (conn) => {
      const payload = canonicalJson({
        ...JSON.parse(original.payload),
        eventJson: canonicalJson(raw),
      });
      await conn.execute(
        'UPDATE domain_operations SET source=?,incarnation=?,operation_id=?,context_json=?,payload_json=?,payload_hash=? WHERE operation_id=?',
        [
          'home',
          'home-store',
          canonicalJson(['home', 'home-store', original.stream, 1]),
          '[]',
          payload,
          createHash('sha256').update(payload).digest('hex'),
          original.operationId,
        ],
      );
      const [foreign] = await membershipOperations(conn, f.user);
      const secondId = canonicalJson([
        'third',
        'third-store',
        foreign.stream,
        1,
      ]);
      await conn.execute(
        'INSERT INTO domain_operations(operation_id,source,incarnation,stream,sequence,semantic_key,kind,context_json,payload_hash,payload_json,applied) SELECT ?,?,?,stream,sequence,semantic_key,kind,context_json,payload_hash,payload_json,applied FROM domain_operations WHERE operation_id=?',
        [secondId, 'third', 'third-store', foreign.operationId],
      );
      await conn.execute(
        'UPDATE prejoin_memberships SET event_json=? WHERE room_id=? AND user_id=?',
        [canonicalJson(normalized.pdu), f.roomId, f.user],
      );
      await bindMembershipDisplay(
        conn,
        f.roomId,
        f.user,
        await membershipOperations(conn, f.user),
      );
    });
    const before = await f.deps.server.tx((conn) =>
      membershipOperations(conn, f.user)
    );
    await f.reopen();
    await f.deps.server.tx((conn) =>
      recordMembershipOperation(conn, f.roomId, f.user)
    );
    assertEquals(
      await f.deps.server.tx((conn) => membershipOperations(conn, f.user)),
      before,
      'normalized display must retain both original source identities without a recaptured local fact',
    );
    const selected = await f.deps.server.query(
      'SELECT operation_id FROM domain_frontiers ORDER BY operation_id',
    );
    assertEquals(
      selected.map((row) => String(row.operation_id)),
      before.map((op) => op.operationId).sort(),
    );
    // A saved binding is meaningful only with the same complete selection.
    await assertRejects(
      () =>
        f.deps.server.tx(async (conn) => {
          await conn.execute(
            'DELETE FROM domain_frontiers WHERE operation_id=?',
            [before[0].operationId],
          );
          await recordMembershipOperation(conn, f.roomId, f.user);
        }),
      Error,
      'membership display binding unavailable',
    );
    await f.reject();
    const after = await f.deps.server.tx((conn) =>
      membershipOperations(conn, f.user)
    );
    assertEquals(after.length, before.length + 1);
    const successor = after.find((op) => op.source === 'edge');
    assert(successor);
    assertEquals(JSON.parse(successor.payload).status, 'rejecting');
    assertEquals(successor.context.map((dot) => dot.source).sort(), [
      'home',
      'third',
    ]);
  }, 'edge'));

Deno.test('prejoin: display binding refuses an incomplete or stale subset without changing selection', () =>
  fixture(async (f) => {
    const selected = await f.deps.server.tx((conn) =>
      membershipOperations(conn, f.user)
    );
    const before = await f.deps.server.query('SELECT * FROM domain_frontiers');
    await assertRejects(
      () =>
        f.deps.server.tx((conn) =>
          bindMembershipDisplay(conn, f.roomId, f.user, [])
        ),
      Error,
      'membership display selection changed',
    );
    assertEquals(
      await f.deps.server.query('SELECT * FROM domain_frontiers'),
      before,
    );
    await assertRejects(
      () =>
        f.deps.server.tx((conn) =>
          bindMembershipDisplay(conn, f.roomId, f.user, [{
            ...selected[0],
            payloadHash: 'changed',
          }])
        ),
      Error,
      'membership display selection changed',
    );
    assertEquals(
      await f.deps.server.query('SELECT * FROM domain_frontiers'),
      before,
    );
  }, 'edge'));

Deno.test('prejoin: semantic source freezes its observed room publication without reauthoring a hidden older invite', () =>
  fixture(async (f) => {
    const facts = () =>
      f.deps.server.query(
        "SELECT * FROM domain_operations WHERE kind='membership' ORDER BY sequence",
      );
    const first = await facts();
    assertEquals(
      JSON.parse(String(first[0].payload_json)).publication,
      null,
      'a future receiver needs the original publication relationship, not whichever room snapshot survives export',
    );
    await f.publish();
    await f.publishInvite();
    const newer = await facts();
    assertEquals(
      newer.length,
      2,
      'pre-mutation capture does not restamp the old invite after room publication',
    );
    assertEquals(JSON.parse(String(newer[1].payload_json)).publication, {
      eventId: '$published',
      membership: 'leave',
      follows: true,
    });
    await f.publish();
    await f.deps.server.tx((conn) =>
      recordMembershipOperation(conn, f.roomId, f.user)
    );
    assertEquals(
      await facts(),
      newer,
      'later room publication cannot rewrite original OOB admission intent',
    );
    await f.reopen();
    assertEquals(await facts(), newer);
  }, 'edge'));

Deno.test('prejoin: compensating departure materialization retains its exact signed source intent', () =>
  fixture(async (f) => {
    const facts = () =>
      f.deps.server.query(
        "SELECT * FROM domain_operations WHERE kind='membership' ORDER BY sequence",
      );
    await f.publish();
    f.knockAnswer(() =>
      Promise.resolve(Response.json({ knock_room_state: null }))
    );
    await assertRejects(() =>
      knockRemote(f.roomId, f.user, {}, [f.origin], f.deps)
    );
    assertEquals(
      await pruneRejectIntents(
        f.deps.store,
        f.deps.server,
        f.deps.self,
        f.origin,
      ),
      1,
    );
    const intent = await inviteFor(f.roomId, f.user, f.deps);
    assert(intent);
    assertEquals(intent.status, 'rejecting');
    assertEquals(intent.localLeaveJson, null);
    const before = await facts();
    const departure = await prejoinDeparture(intent, f.deps);
    assert(departure);
    const retained = await facts();
    assertEquals(
      retained.length,
      before.length + 1,
      'the real signed departure and its export intent must commit together',
    );
    assertEquals(
      JSON.parse(
        JSON.parse(String(retained.at(-1)!.payload_json)).localLeaveJson,
      ),
      departure,
    );
    await f.reopen();
    const current = await inviteFor(f.roomId, f.user, f.deps);
    assert(current);
    assertEquals(await prejoinDeparture(current, f.deps), departure);
    assertEquals(await facts(), retained);
  }, 'edge'));
Deno.test('prejoin: signing dependency survives the server owner callback', () =>
  fixture(async (f) => {
    const before = await inviteFor(f.roomId, f.user, f.deps);
    const original = f.deps.server.tx.bind(f.deps.server);
    let current = true;
    const signer = {
      ...f.deps.signer,
      admit: () => {
        if (!current) throw new Error('signing authority retired');
      },
    };
    f.deps.server.tx = (fn, options) =>
      original(async (conn) => {
        const result = await fn(conn);
        current = false;
        return result;
      }, options);
    try {
      await assertRejects(
        () =>
          rejectInviteRemote(f.roomId, f.user, {
            ...f.deps,
            signer,
          }),
        Error,
        'signing authority retired',
      );
    } finally {
      f.deps.server.tx = original;
    }
    assertEquals(await inviteFor(f.roomId, f.user, f.deps), before);
  }));

Deno.test('prejoin: repeated concurrent rejection retains one signed local departure and revision', () =>
  fixture(async (f) => {
    await Promise.all(
      Array.from({ length: 4 }, () => f.reject('account deactivated')),
    );
    const before = await inviteFor(f.roomId, f.user, f.deps);
    assertEquals(before?.status, 'rejecting');
    assert(before?.localLeaveJson);
    await rejectInviteRemote(f.roomId, f.user, {
      ...f.deps,
      signer: {
        ...f.deps.signer,
        sign: () =>
          Promise.reject(new Error('completed departure must not sign again')),
      },
    });
    assertEquals(await inviteFor(f.roomId, f.user, f.deps), before);
    assertEquals(before.revision, 2);
  }));

// A facade's request signer opens the server file to capture its permit. Only
// the returned byte signer may run inside that file's lifecycle transaction.
function guardDepartureSigner(deps: InviteDeps) {
  const server = deps.server;
  const transact = server.tx.bind(server);
  const signer = deps.signer;
  let inTransaction = false;
  let preparations = 0;
  let signatures = 0;
  let available = true;
  server.tx = async (fn) => {
    inTransaction = true;
    try {
      return await transact(fn);
    } finally {
      inTransaction = false;
    }
  };
  deps.signer = {
    serverName: signer.serverName,
    keyId: signer.keyId,
    sign: () => Promise.reject(new Error('raw request signer in departure')),
    prepare: async () => {
      assert(
        !inTransaction,
        'signing permit opens the server outside its transaction',
      );
      assert(available, 'new signing authority is unavailable');
      await server.query('SELECT 1');
      preparations++;
      return {
        serverName: signer.serverName,
        keyId: signer.keyId,
        sign: (bytes) => {
          assert(
            inTransaction,
            'departure bytes signed at their atomic transition',
          );
          signatures++;
          return signer.sign(bytes);
        },
      } satisfies Signer;
    },
  };
  return {
    counts: () => [preparations, signatures],
    expire: () => available = false,
    restore: () => server.tx = transact,
  };
}

Deno.test('prejoin authority: rejection captures one permit outside its atomic transaction and cold retries need none', () =>
  fixture(async (f) => {
    const guarded = guardDepartureSigner(f.deps);
    try {
      await Promise.all(Array.from({ length: 4 }, () => f.reject('not now')));
      assertEquals(guarded.counts(), [1, 1]);
      const saved = await inviteFor(f.roomId, f.user, f.deps);
      assert(saved?.localLeaveJson);
      const local = JSON.parse(saved.localLeaveJson) as Pdu;
      await assertAuthored(local);
      assertEquals(local.content.reason, 'not now');
      assertEquals(saved.revision, 2);
      guarded.expire();
      await f.reject('a retry cannot replace the reason');
      assertEquals(await inviteFor(f.roomId, f.user, f.deps), saved);
      assertEquals(guarded.counts(), [1, 1]);
      guarded.restore();
      await f.reopen();
      const cut = await eventStreamMax(f.deps.server);
      await f.reject();
      assertEquals(await inviteFor(f.roomId, f.user, f.deps), saved);
      assertEquals(await prejoinDeparture(saved, f.deps), local);
      assertEquals(await eventStreamMax(f.deps.server), cut);
      assertEquals(guarded.counts(), [1, 1]);
      assertEquals(await f.deps.store.rooms(), []);
    } finally {
      guarded.restore();
    }
  }));

Deno.test('prejoin authority: legacy departure materializes with a prepared permit once and retains its revision cut', () =>
  fixture(async (f) => {
    await f.reject();
    await f.deps.server.execute(
      'UPDATE prejoin_memberships SET local_leave_json=NULL WHERE room_id=? AND user_id=?',
      [f.roomId, f.user],
    );
    const legacy = await inviteFor(f.roomId, f.user, f.deps);
    assert(legacy);
    const cut = await eventStreamMax(f.deps.server);
    const guarded = guardDepartureSigner(f.deps);
    try {
      const leave = await prejoinDeparture(legacy, f.deps);
      assert(leave);
      await assertAuthored(leave);
      assertEquals(guarded.counts(), [1, 1]);
      assertEquals(
        (await inviteFor(f.roomId, f.user, f.deps))?.revision,
        legacy.revision,
      );
      assertEquals(await eventStreamMax(f.deps.server), cut);
      guarded.expire();
      // Even an old caller snapshot must read the already prepared departure
      // before trying to acquire new signing authority.
      assertEquals(await prejoinDeparture(legacy, f.deps), leave);
      guarded.restore();
      await f.reopen();
      assertEquals(await prejoinDeparture(legacy, f.deps), leave);
      assertEquals(await eventStreamMax(f.deps.server), cut);
      assertEquals(guarded.counts(), [1, 1]);
      await f.deps.server.execute(
        'UPDATE prejoin_memberships SET revision=revision+1 WHERE room_id=? AND user_id=?',
        [f.roomId, f.user],
      );
      assertEquals(await prejoinDeparture(legacy, f.deps), null);
      assertEquals(guarded.counts(), [1, 1]);
    } finally {
      guarded.restore();
    }
  }));

Deno.test('prejoin authority: unavailable permit or failed byte signing leaves rejection and legacy rows unchanged', async (t) => {
  for (const legacy of [false, true]) {
    for (const cut of ['prepare', 'sign']) {
      await t.step(
        `${legacy ? 'legacy' : 'rejection'} ${cut}`,
        () =>
          fixture(async (f) => {
            if (legacy) {
              await f.reject();
              await f.deps.server.execute(
                'UPDATE prejoin_memberships SET local_leave_json=NULL WHERE room_id=? AND user_id=?',
                [f.roomId, f.user],
              );
            }
            const before = await inviteFor(f.roomId, f.user, f.deps);
            assert(before);
            const head = await eventStreamMax(f.deps.server);
            const signer = f.deps.signer;
            const failure = () => Promise.reject(new Error(`failed ${cut}`));
            f.deps.signer = {
              ...signer,
              sign: () => Promise.reject(new Error('raw signer is forbidden')),
              prepare: cut === 'prepare'
                ? failure
                : () => Promise.resolve({ ...signer, sign: failure }),
            };
            await assertRejects(
              () => legacy ? prejoinDeparture(before, f.deps) : f.reject(),
              Error,
              `failed ${cut}`,
            );
            assertEquals(await inviteFor(f.roomId, f.user, f.deps), before);
            assertEquals(await eventStreamMax(f.deps.server), head);
            assertEquals(await f.deps.store.rooms(), []);
          }),
      );
    }
  }
});

Deno.test('prejoin: late rejection completion cannot overtake a room publication', () =>
  fixture(async (f) => {
    await f.reject();
    const job = await inviteIntentProvider(f.deps)(f.deps.server, f.origin);
    assert(job);
    const running = job.run();
    await f.sent;
    const cut = await f.publish();
    await assertRejects(() => admitLocalJoin(f.deps.store, f.roomId, f.user));
    f.finish();
    await running;
    assertEquals(await eventStreamMax(f.deps.server), cut);
    assertEquals(await inviteFor(f.roomId, f.user, f.deps), null);
    await admitLocalJoin(f.deps.store, f.roomId, f.user);
  }));

Deno.test('prejoin reason: invite and knock departures persist and send the user reason, including empty', async () => {
  for (const kind of ['invite', 'knock']) {
    for (const reason of ['not now', '', undefined]) {
      await fixture(async (f) => {
        if (kind === 'knock') {
          await f.publish();
          await knockRemote(f.roomId, f.user, {}, [f.origin], f.deps);
        }
        await f.reject(reason);
        const saved = await inviteFor(f.roomId, f.user, f.deps);
        assert(saved?.localLeaveJson);
        const local = JSON.parse(saved.localLeaveJson) as Pdu;
        assertEquals(local.content.reason, reason);
        await assertAuthored(local);
        // This freshly reads durable intent, not the object saved above.
        const job = await inviteIntentProvider(f.deps)(f.deps.server, f.origin);
        assert(job);
        const running = job.run();
        try {
          await f.sent;
          const sent = f.sentLeave();
          assert(sent);
          assertEquals(sent.content.reason, reason);
          await assertAuthored(sent);
          const pending = await inviteFor(f.roomId, f.user, f.deps);
          assert(pending?.leaveJson);
          assertEquals(JSON.parse(pending.leaveJson).content.reason, reason);
        } finally {
          f.finish();
          await running;
        }
      });
    }
  }
});

Deno.test('prejoin: superseded unsent rejection is settled without blocking admission', () =>
  fixture(async (f) => {
    await f.reject();
    const cut = await f.publish();
    await admitLocalJoin(f.deps.store, f.roomId, f.user);
    assertEquals(await eventStreamMax(f.deps.server), cut);
    assertEquals(
      await inviteIntentProvider(f.deps)(f.deps.server, f.origin),
      null,
    );
  }));

Deno.test('prejoin: a hidden revision does not prevent a fresh remote knock', () =>
  fixture(async (f) => {
    await f.publish();
    const result = await knockRemote(f.roomId, f.user, {}, [f.origin], f.deps);
    assertEquals(result.roomId, f.roomId);
    const current = await inviteFor(f.roomId, f.user, f.deps);
    assertEquals(current?.revision, 2);
    assertEquals(current?.status, 'pending');
  }));

Deno.test('prejoin knock: supersession before dispatch cannot report a completed knock', () =>
  fixture(async (f) => {
    await f.publish();
    const query = f.deps.server.query.bind(f.deps.server);
    let armed = true;
    f.deps.server.query = async (sql, args) => {
      const rows = await query(sql, args);
      if (
        armed && sql.includes('AS visible FROM prejoin_memberships p') &&
        rows[0]?.status === 'attempting'
      ) {
        armed = false;
        await f.publish();
        return await query(sql, args);
      }
      return rows;
    };
    await assertRejects(
      () => knockRemote(f.roomId, f.user, {}, [f.origin], f.deps),
      Error,
      'membership changed during knock',
    );
    assertEquals(armed, false);
    assertEquals(f.knockRequests(), 0);
    assertEquals(await inviteFor(f.roomId, f.user, f.deps), null);
  }));

Deno.test('prejoin knock: completed exact retry after restart succeeds without another dispatch or signature', () =>
  fixture(async (f) => {
    await f.publish();
    await knockRemote(f.roomId, f.user, {}, [f.origin], f.deps);
    const completed = await inviteFor(f.roomId, f.user, f.deps);
    assert(completed);
    const cut = await eventStreamMax(f.deps.server);
    await f.reopen();
    f.deps.signer = {
      ...f.deps.signer,
      sign: () => Promise.reject(new Error('completed knock must not sign')),
    };
    assertEquals(await performKnockAttempt(completed, f.deps), true);
    assertEquals(f.knockRequests(), 1);
    assertEquals(await inviteFor(f.roomId, f.user, f.deps), completed);
    assertEquals(await eventStreamMax(f.deps.server), cut);
  }));

Deno.test('prejoin knock: a late response cannot overtake a newer publication', () =>
  fixture(async (f) => {
    await f.publish();
    let cut = 0;
    f.knockAnswer(async () => {
      cut = await f.publish();
      return Response.json({ knock_room_state: [] });
    });
    await assertRejects(
      () => knockRemote(f.roomId, f.user, {}, [f.origin], f.deps),
      Error,
      'membership changed during knock',
    );
    assertEquals(f.knockRequests(), 1);
    assertEquals(await inviteFor(f.roomId, f.user, f.deps), null);
    assertEquals(await eventStreamMax(f.deps.server), cut);
  }));

Deno.test('prejoin knock: provider skips held claims and settles superseded attempts', async (t) => {
  await t.step(
    'held member does not starve another job at the same destination',
    () =>
      fixture(async (f) => {
        await f.publish();
        f.knockAnswer(() => Promise.resolve(Response.json({})));
        for (const user of [f.user, '@other:test']) {
          await assertRejects(() =>
            knockRemote(f.roomId, user, {}, [f.origin], f.deps)
          );
        }
        const first = await inviteFor(f.roomId, f.user, f.deps);
        const other = await inviteFor(f.roomId, '@other:test', f.deps);
        assert(first);
        assert(other);
        const release = beginPrejoinJob(f.deps.store, first);
        assert(release);
        const provider = inviteIntentProvider(f.deps);
        f.knockAnswer(() =>
          Promise.resolve(Response.json({ knock_room_state: [] }))
        );
        try {
          const job = await provider(f.deps.server, f.origin);
          assert(job);
          assertEquals(job.id, 'knock-attempt:' + prejoinJobId(other));
          await job.run();
          assertEquals(
            (await inviteFor(f.roomId, '@other:test', f.deps))?.status,
            'pending',
          );
          assertEquals(await provider(f.deps.server, f.origin), null);
          assertEquals(
            (await inviteFor(f.roomId, f.user, f.deps))?.status,
            'attempting',
          );
        } finally {
          release();
        }
        const resumed = await provider(f.deps.server, f.origin);
        assert(resumed);
        await resumed.run();
        assertEquals(
          (await inviteFor(f.roomId, f.user, f.deps))?.status,
          'pending',
        );
        assertEquals(f.knockRequests(), 4);
        assertEquals(await provider(f.deps.server, f.origin), null);
      }),
  );
  await t.step(
    'a newer publication is terminal, not repeatedly selected',
    () =>
      fixture(async (f) => {
        await f.publish();
        f.knockAnswer(() => Promise.resolve(Response.json({})));
        await assertRejects(() =>
          knockRemote(f.roomId, f.user, {}, [f.origin], f.deps)
        );
        const cut = await f.publish();
        const provider = inviteIntentProvider(f.deps);
        assertEquals(await provider(f.deps.server, f.origin), null);
        assertEquals(await provider(f.deps.server, f.origin), null);
        assertEquals(f.knockRequests(), 1);
        assertEquals(await eventStreamMax(f.deps.server), cut);
        assertEquals(await prejoinJobs(f.deps.server), []);
      }),
  );
});

Deno.test('prejoin knock: uncertain response retains the exact attempt for the cold sender owner', () =>
  fixture(async (f) => {
    await f.publish();
    f.knockAnswer(() => Promise.resolve(Response.json({})));
    await assertRejects(() =>
      knockRemote(f.roomId, f.user, { reason: 'held' }, [f.origin], f.deps)
    );
    const attempt = await inviteFor(f.roomId, f.user, f.deps);
    assert(attempt);
    assertEquals(attempt.status, 'attempting');
    assertEquals(f.knockRequests(), 1);
    await f.reopen();
    f.knockAnswer(() =>
      Promise.resolve(Response.json({ knock_room_state: [] }))
    );
    const job = await inviteIntentProvider(f.deps)(f.deps.server, f.origin);
    assert(job);
    await job.run();
    const completed = await inviteFor(f.roomId, f.user, f.deps);
    assertEquals(completed?.status, 'pending');
    assertEquals(completed?.eventId, attempt.eventId);
    assertEquals(completed?.revision, attempt.revision);
    assertEquals(completed?.eventJson, attempt.eventJson);
    assertEquals(f.sentKnocks()[1], f.sentKnocks()[0]);
    assertEquals(f.knockRequests(), 2);
    assertEquals(
      await inviteIntentProvider(f.deps)(f.deps.server, f.origin),
      null,
    );
    assertEquals(await f.deps.store.rooms(), []);
  }));

Deno.test('prejoin knock: a later invitation survives the old attempt response and retry', () =>
  fixture(async (f) => {
    await f.publish();
    const snapshots: Array<Awaited<ReturnType<typeof inviteFor>>> = [];
    f.knockAnswer(async () => {
      snapshots.push(await inviteFor(f.roomId, f.user, f.deps));
      await f.publishInvite();
      snapshots.push(await inviteFor(f.roomId, f.user, f.deps));
      return Response.json({ knock_room_state: [] });
    });
    await assertRejects(
      () => knockRemote(f.roomId, f.user, {}, [f.origin], f.deps),
      Error,
      'membership changed during knock',
    );
    const [attempt, invitation] = snapshots;
    assert(attempt);
    assert(invitation);
    assertEquals(invitation.kind, 'invite');
    const cut = await eventStreamMax(f.deps.server);
    assertEquals(await performKnockAttempt(attempt, f.deps), false);
    assertEquals(f.knockRequests(), 1);
    assertEquals(await inviteFor(f.roomId, f.user, f.deps), invitation);
    assertEquals(await eventStreamMax(f.deps.server), cut);
  }));
