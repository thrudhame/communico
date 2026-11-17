import { assert, assertEquals, assertRejects } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import { setConfigForTests } from '#engine/config.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import {
  type InviteDeps,
  inviteFor,
  inviteIntentProvider,
  markInviteJoined,
  prejoinDeparture,
  pruneRejectIntents,
  receiveInvite,
  rejectInviteRemote,
} from '#engine/federation/invites.ts';
import { knockRemote, performKnockAttempt } from '#engine/federation/knocks.ts';
import { toWire } from '#engine/federation/pdu.ts';
import { admitLocalJoin } from '#engine/room/hooks.ts';
import { roomSchema } from '#engine/room/index.ts';
import { installJoinAdmission } from '#engine/server/join-attempts.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { recordMembershipOperation } from '#engine/server/membership-operations.ts';
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
            ...room.makeLeaveTemplate('@dev:test').event as Record<
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
      await pruneRejectIntents(f.deps.server, f.deps.self, f.origin),
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
