import { assert, assertEquals, assertRejects } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import {
  type InviteDeps,
  inviteFor,
  inviteIntentProvider,
  prejoinDeparture,
  receiveInvite,
  rejectInviteRemote,
} from '#engine/federation/invites.ts';
import { knockRemote } from '#engine/federation/knocks.ts';
import { admitLocalJoin } from '#engine/room/hooks.ts';
import { roomSchema } from '#engine/room/index.ts';
import { installJoinAdmission } from '#engine/server/join-attempts.ts';
import { serverSchema } from '#engine/server/schema.ts';
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
    reject: (reason?: string) => Promise<void>;
    sentLeave: () => Pdu | null;
    sent: Promise<void>;
    finish: () => void;
    reopen: () => Promise<void>;
  }) => Promise<void>,
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
        return Response.json({ knock_room_state: [] });
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
      reject: (reason) => reject(room.roomId, user, deps, reason),
      sentLeave: () => sentLeave,
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
