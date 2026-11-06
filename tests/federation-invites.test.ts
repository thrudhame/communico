// tests/federation-invites.test.ts — invites both ways at the engine
// functions (routing is stage 5). Inviter: the /v2/invite request shape
// (stripped list incl. the create with origin_server_ts), merged
// signatures, outbox to room servers, the gate. Invitee: the validation
// matrix, the countersigned response, the federation_invites row.
// Reject: 'rejecting' at once + the intent performing make/send_leave
// against the fake; an unreachable inviter leaves the dance queued (no
// local-only fallback); the second candidate from the stripped state is
// tried. Rescind both ways. (doltgres tests/federation-invites.test.ts,
// restored at the engine functions — /sync rendering is stage 5.)
import { assert, assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { type FakeServer, startFakeServer } from './federation/fake-server.ts';
import { createFakeRoom, type FakeRoom } from './federation/fake-room.ts';
import {
  acceptRescind,
  type InviteDeps,
  inviteFor,
  inviteIntentProvider,
  inviteRemote,
  markInviteJoined,
  receiveInvite,
  rejectInviteRemote,
} from '#engine/federation/invites.ts';
import { productionKeyResolver } from '#engine/federation/keyresolver.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { startSender } from '#engine/federation/sender.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
} from '#engine/signing-primitives.js';
import { openStore, type Store } from '#engine/store/index.ts';
import { genesis } from './fixtures/genesis.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
  wireOf,
} from './fixtures/remote.ts';
import { testRemoteServer, testSigner } from './fixtures/signer.ts';
import { assertAuthored } from './fixtures/authored.ts';

async function ourKeyDoc(name: string): Promise<Record<string, unknown>> {
  const us = await testRemoteServer(name);
  return {
    server_name: name,
    verify_keys: {
      [us.keyId]: {
        key: b64encodeStd(await exportPublicKeyRaw(us.kp.publicKey)),
      },
    },
    old_verify_keys: {},
    valid_until_ts: Date.now() + 86400_000,
    signatures: {},
  };
}

installServerHooks();

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

async function withStore(
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(config(dir), {
    schemas: { room: roomSchema, server: serverSchema },
  });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function waitFor(
  what: () => Promise<boolean> | boolean,
  ms = 15000,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await what()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

// --- INVITER -----------------------------------------------------------------

type InviteHost = {
  fake: FakeServer;
  inviteRequests: {
    room_version: unknown;
    event: Record<string, unknown>;
    invite_room_state: Record<string, unknown>[];
  }[];
};

async function withInviteHost<T>(
  fn: (h: InviteHost) => Promise<T>,
): Promise<T> {
  setConfigForTests({
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  resetCaCertsForTests();
  const h: InviteHost = {
    fake: undefined as unknown as FakeServer,
    inviteRequests: [],
  };
  const ourDoc = await ourKeyDoc('test');
  const handlers = (req: {
    url: URL;
    json(): unknown;
    method: string;
  }): Response | Promise<Response> | null => {
    const path = req.url.pathname;
    if (path.startsWith('/_matrix/federation/v2/invite/')) {
      const body = req.json() as {
        room_version: unknown;
        event: Record<string, unknown>;
        invite_room_state: Record<string, unknown>[];
      };
      h.inviteRequests.push(body);
      // the fake signs the invite as the invitee's server — over the
      // redacted form without the id, like any v3+ signer
      return (async () => {
        const { redact } = await import('#engine/eventid.ts');
        const redacted = redact(body.event, '11');
        delete redacted.event_id;
        const signedRedacted = await h.fake.sign(redacted);
        const signed = {
          ...body.event,
          signatures: signedRedacted.signatures,
        };
        return Response.json({ event: signed });
      })();
    }
    return null;
  };
  h.fake = await startFakeServer({
    ourKeyDoc: () => Promise.resolve(ourDoc),
    handlers,
  });
  try {
    return await fn(h);
  } finally {
    await h.fake.close();
    setConfigForTests({ federation: { cacerts: [] } });
    resetCaCertsForTests();
  }
}

Deno.test('inviter: the /v2/invite shape, merged signatures, outbox to joined servers, the gate', async () => {
  await withStore(async (store) => {
    await withInviteHost(async (h) => {
      const server = await store.server();
      const g = await genesis(store, {
        roomId: '!fed-inv:test',
        joinRule: 'public',
      });
      const dest = h.fake.name;
      // a remote member so the invite's outbox union is non-empty
      const remoteMember = { name: dest, keyId: h.fake.keyId, kp: h.fake.kp };
      const join = await remoteEvent(g.roomId, remoteMember, '11', {
        type: 'm.room.member',
        sender: `@rudy:${dest}`,
        state_key: `@rudy:${dest}`,
        content: { membership: 'join' },
        prev_events: [g.tipId],
        auth_events: [g.createId],
        origin_server_ts: 100,
      });
      const joined = await ingestRemote(g.room, [join], dest, {
        keys: fakeKeyResolver(remoteMember),
        fetcher: fakeFetcher({}).fetcher,
        self: g.signer.serverName,
        limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
        ungroundedMs: 3_600_000,
      });
      assertEquals(joined[0].outcome, 'accepted');
      const deps: InviteDeps = {
        store,
        server,
        signer: g.signer,
        keys: productionKeyResolver(server, g.signer),
        self: g.signer.serverName,
        wake: () => {},
      };
      const zoe = `@zoe:${dest}`;
      const res = await inviteRemote(
        g.roomId,
        '@dev:test',
        zoe,
        undefined,
        undefined,
        deps,
      );
      // the request shape: room_version, event, invite_room_state
      assertEquals(h.inviteRequests.length, 1);
      const req = h.inviteRequests[0];
      assertEquals(req.room_version, '11');
      await assertAuthored(req.event);
      assertEquals(req.event.type, 'm.room.member');
      assertEquals(
        (req.event.content as Record<string, unknown>).membership,
        'invite',
      );
      const stripped = req.invite_room_state;
      const create = stripped.find((e) => e.type === 'm.room.create');
      assert(create !== undefined, 'the create is required');
      assert(
        typeof create.origin_server_ts === 'number',
        'MSC-4311 shape',
      );
      assert(
        stripped.some((e) =>
          e.type === 'm.room.member' && e.state_key === '@dev:test'
        ),
        'the inviter’s member event rides',
      );
      // the merged event ingested with BOTH signatures
      const room = await openRoom(store, g.roomId);
      const stored = await room.tx(async (tx) => {
        const row = await tx.events.get(res.eventId);
        assert(row !== null, 'the merged invite is in the room');
        return (JSON.parse(row.pdu) as Pdu).signatures;
      });
      assert(stored['test'] !== undefined, 'our signature');
      assert(stored[dest] !== undefined, 'the invitee’s signature');
      // outbox rows for the invite go to the room's joined servers (rudy's)
      await waitFor(async () => {
        const rows = await server.query(
          "SELECT event FROM outbox WHERE destination = ? AND state = 'pending'",
          [dest],
        );
        return rows.some((r) => String(r.event) === res.eventId);
      }, 3000);
      // the gate: closed mode → 403, a pending outbound row
      setConfigForTests({ federation: { mode: 'closed' } });
      try {
        let status = 0;
        try {
          await inviteRemote(
            g.roomId,
            '@dev:test',
            '@walt:stranger.test',
            undefined,
            undefined,
            deps,
          );
        } catch (e) {
          status = (e as MatrixError).status;
        }
        assertEquals(status, 403);
        const pending = await server.query(
          "SELECT kind FROM federation_pending WHERE name = 'stranger.test' AND kind = 'outbound'",
          [],
        );
        assertEquals(pending.length, 1, 'the outbound intent is bucketed');
      } finally {
        setConfigForTests({ federation: { mode: 'open' } });
      }
    });
  });
});

// --- INVITEE -----------------------------------------------------------------

async function inviteDepsFor(
  store: Store,
  srv: Awaited<ReturnType<typeof makeRemoteServer>>,
): Promise<InviteDeps> {
  const server = await store.server();
  const signer = await testSigner();
  return {
    store,
    server,
    signer,
    keys: fakeKeyResolver(srv),
    self: 'test',
    wake: () => {},
  };
}

async function remoteInvite(
  srv: Awaited<ReturnType<typeof makeRemoteServer>>,
  roomId: string,
  target: string,
  prev: string[],
): Promise<Pdu> {
  return await remoteEvent(roomId, srv, '11', {
    type: 'm.room.member',
    sender: `@zoe:${srv.name}`,
    state_key: target,
    content: { membership: 'invite' },
    prev_events: prev,
    auth_events: [],
  });
}

Deno.test('invitee: the validation matrix, the countersigned answer, the stored row', async () => {
  await withStore(async (store) => {
    const srv = await makeRemoteServer('remote.test');
    const deps = await inviteDepsFor(store, srv);
    const roomId = '!their-room:remote.test';
    const invite = await remoteInvite(srv, roomId, '@dev:test', ['$p1']);
    const eventId = String(invite.event_id);
    const body = {
      room_version: '11',
      event: wireOf(invite),
      invite_room_state: [],
    };
    const attempt = async (
      b: unknown,
      id = eventId,
    ): Promise<number> => {
      try {
        await receiveInvite(roomId, id, b, 'remote.test', deps);
        return 200;
      } catch (e) {
        return (e as MatrixError).status;
      }
    };
    // validation matrix
    assertEquals(await attempt({ ...body, room_version: '99' }), 400);
    assertEquals(
      await attempt({
        ...body,
        event: { ...(body.event as object), type: 'm.room.message' },
      }),
      400,
    );
    assertEquals(
      await attempt({
        ...body,
        event: {
          ...(body.event as object),
          state_key: '@nope:elsewhere.test',
        },
      }),
      400,
    );
    assertEquals(await attempt(body, '$wrong-id'), 400);
    const badSig = JSON.parse(JSON.stringify(body)) as {
      room_version: string;
      event: Record<string, unknown>;
      invite_room_state: unknown[];
    };
    ((badSig.event as Record<string, unknown>).signatures as Record<
      string,
      Record<string, string>
    >)['remote.test'] = { 'ed25519:1': 'AAAA' };
    assertEquals(await attempt(badSig), 403);
    // the good invite
    const good = await receiveInvite(
      roomId,
      eventId,
      body,
      'remote.test',
      deps,
    );
    const answered = good.event as Record<string, unknown>;
    assertEquals('origin' in answered, false);
    assertEquals(answered.hashes, invite.hashes);
    assert(
      (answered.signatures as Record<string, unknown>)['test'] !== undefined,
      'our signature on the answer',
    );
    // the row, stripped state and both signatures kept
    const row = await inviteFor(roomId, '@dev:test', deps);
    assert(row !== null);
    assertEquals(row.status, 'pending');
    assertEquals(row.origin, 'remote.test');
    const storedEvent = JSON.parse(row.eventJson) as Pdu;
    const { signatures: _signatures, ...unchanged } = storedEvent;
    const { signatures: _originalSignatures, ...original } = invite;
    assertEquals(unchanged, original);
    assert(storedEvent.signatures['test'] !== undefined);
    assert(storedEvent.signatures['remote.test'] !== undefined);
    // accepting marks it joined
    await markInviteJoined(roomId, '@dev:test', deps);
    assertEquals(
      (await inviteFor(roomId, '@dev:test', deps))?.status,
      'joined',
    );
  });
});

// --- REJECT ------------------------------------------------------------------

Deno.test('reject: local effect at once + the intent performs make/send_leave against the fake', async () => {
  await withStore(async (store) => {
    setConfigForTests({
      federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
    });
    resetCaCertsForTests();
    try {
      const server = await store.server();
      const h = {
        fake: undefined as unknown as FakeServer,
        room: undefined as unknown as FakeRoom,
        makeLeaveCalls: [] as string[],
        sendLeaveCalls: [] as Record<string, unknown>[],
      };
      const ourDoc = await ourKeyDoc('test');
      const handlers = (req: {
        url: URL;
        json(): unknown;
        method: string;
      }): Response | null => {
        const path = req.url.pathname;
        if (path.startsWith('/_matrix/federation/v1/make_leave/')) {
          const userId = decodeURIComponent(path.split('/').pop()!);
          h.makeLeaveCalls.push(userId);
          return Response.json(h.room.makeLeaveTemplate(userId));
        }
        if (path.startsWith('/_matrix/federation/v2/send_leave/')) {
          h.sendLeaveCalls.push(req.json() as Record<string, unknown>);
          return Response.json({});
        }
        return null;
      };
      h.fake = await startFakeServer({
        ourKeyDoc: () => Promise.resolve(ourDoc),
        handlers,
      });
      try {
        h.room = await createFakeRoom({
          version: '11',
          creator: `@zoe:${h.fake.name}`,
          server: {
            name: h.fake.name,
            keyId: h.fake.keyId,
            kp: h.fake.kp,
          },
        });
        // the fake invites our dev into its room
        const inviteEvent = await h.room.addEvent({
          type: 'm.room.member',
          sender: `@zoe:${h.fake.name}`,
          state_key: '@dev:test',
          content: { membership: 'invite' },
        });
        const remoteMember = {
          name: h.fake.name,
          keyId: h.fake.keyId,
          kp: h.fake.kp,
        };
        const signer = await testSigner();
        const sender = startSender({ store, signer });
        const deps: InviteDeps = {
          store,
          server,
          signer,
          keys: fakeKeyResolver(remoteMember),
          self: 'test',
          wake: (d) => sender.wake(d),
        };
        sender.setIntentProvider(inviteIntentProvider(deps));
        try {
          const received = await receiveInvite(
            h.room.roomId,
            String(inviteEvent.event_id),
            {
              room_version: '11',
              event: h.room.wire(inviteEvent),
              invite_room_state: [],
            },
            h.fake.name,
            deps,
          );
          assert(
            (received.event as Record<string, unknown>).signatures !==
              undefined,
          );
          // reject: the row goes 'rejecting' at once
          await rejectInviteRemote(h.room.roomId, '@dev:test', deps);
          assertEquals(
            (await inviteFor(h.room.roomId, '@dev:test', deps))?.status,
            'rejecting',
          );
          // the intent performs make_leave + send_leave against the fake
          await waitFor(() => h.sendLeaveCalls.length >= 1, 10000);
          // Receipt precedes the response and the sender's durable completion.
          await waitFor(
            async () =>
              (await inviteFor(h.room.roomId, '@dev:test', deps))?.status ===
                'rejected',
            10000,
          );
          assert(h.makeLeaveCalls.includes('@dev:test'));
          await assertAuthored(h.sendLeaveCalls[0]);
          assertEquals(
            (await inviteFor(h.room.roomId, '@dev:test', deps))?.status,
            'rejected',
          );
          // the signed leave is what stage 5 renders
          const rendered = JSON.parse(
            (await inviteFor(h.room.roomId, '@dev:test', deps))!.eventJson,
          ) as Record<string, unknown>;
          assertEquals(rendered.type, 'm.room.member');
          await assertAuthored(rendered);
          assertEquals(
            (rendered.content as Record<string, unknown>).membership,
            'leave',
          );
          assert(
            (rendered.signatures as Record<string, unknown>)['test'] !==
              undefined,
            'our signature on the leave',
          );
          // the intent row is spent — nothing left for the fake
          assertEquals(
            (await server.query(
              "SELECT 1 FROM federation_invites WHERE status = 'rejecting'",
              [],
            )).length,
            0,
          );
        } finally {
          await sender.stop();
        }
      } finally {
        await h.fake.close();
      }
    } finally {
      setConfigForTests({ federation: { cacerts: [] } });
      resetCaCertsForTests();
    }
  });
});

Deno.test('reject: an unreachable inviter leaves the dance queued; the second candidate is tried', async () => {
  await withStore(async (store) => {
    setConfigForTests({
      federation: {
        cacerts: ['tests/fixtures/tls/ca.crt'],
        connectms: 1000,
        timeoutms: 3000,
        backoffstartmillihours: 1,
      },
    });
    resetCaCertsForTests();
    try {
      const server = await store.server();
      const dead = await makeRemoteServer('dead.test');
      // the fake is only the SECOND candidate (a server named in the
      // stripped state)
      const sendLeaveCalls: string[] = [];
      const ourDoc = await ourKeyDoc('test');
      let room: FakeRoom;
      const fake = await startFakeServer({
        ourKeyDoc: () => Promise.resolve(ourDoc),
        handlers: (req) => {
          const path = req.url.pathname;
          if (path.startsWith('/_matrix/federation/v1/make_leave/')) {
            const userId = decodeURIComponent(path.split('/').pop()!);
            return Response.json(room.makeLeaveTemplate(userId));
          }
          if (path.startsWith('/_matrix/federation/v2/send_leave/')) {
            sendLeaveCalls.push('called');
            return Response.json({});
          }
          return null;
        },
      });
      try {
        room = await createFakeRoom({
          version: '11',
          creator: `@zoe:${fake.name}`,
          server: { name: fake.name, keyId: fake.keyId, kp: fake.kp },
        });
        await room.addEvent({
          type: 'm.room.member',
          sender: `@zoe:${dead.name}`,
          state_key: '@dev:test',
          content: { membership: 'invite' },
        });
        // signed by the unreachable inviter
        const signed = await remoteEvent(
          room.roomId,
          dead,
          '11',
          {
            type: 'm.room.member',
            sender: `@zoe:${dead.name}`,
            state_key: '@dev:test',
            content: { membership: 'invite' },
            prev_events: room.extremityIds(),
            auth_events: [],
          },
        );
        const signer = await testSigner();
        const sender = startSender({ store, signer });
        const deps: InviteDeps = {
          store,
          server,
          signer,
          keys: fakeKeyResolver(dead),
          self: 'test',
          wake: (d) => sender.wake(d),
        };
        sender.setIntentProvider(inviteIntentProvider(deps));
        try {
          await receiveInvite(
            room.roomId,
            String(signed.event_id),
            {
              room_version: '11',
              event: wireOf(signed),
              invite_room_state: [
                {
                  type: 'm.room.create',
                  state_key: '',
                  content: { room_version: '11', creator: `@zoe:${fake.name}` },
                  sender: `@zoe:${fake.name}`,
                },
              ],
            },
            dead.name,
            deps,
          );
          await rejectInviteRemote(room.roomId, '@dev:test', deps);
          // dead.test fails; the dance does NOT fall back to local-only —
          // the second candidate (from the stripped state) performs it
          await waitFor(() => sendLeaveCalls.length >= 1, 20000);
          await waitFor(
            async () =>
              (await inviteFor(room.roomId, '@dev:test', deps))?.status ===
                'rejected',
            20000,
          );
          assertEquals(
            (await inviteFor(room.roomId, '@dev:test', deps))?.status,
            'rejected',
          );
        } finally {
          await sender.stop();
        }
      } finally {
        await fake.close();
      }
    } finally {
      setConfigForTests({
        federation: {
          cacerts: [],
          connectms: 5000,
          timeoutms: 30000,
          backoffstartmillihours: 125,
        },
      });
      resetCaCertsForTests();
    }
  });
});

// --- RESCIND ------------------------------------------------------------------

Deno.test('rescind: the inviter’s leave rejects the out-of-band invite; a third party’s does not', async () => {
  await withStore(async (store) => {
    const srv = await makeRemoteServer('remote.test');
    const deps = await inviteDepsFor(store, srv);
    const roomId = '!rescind:remote.test';
    const invite = await remoteInvite(srv, roomId, '@dev:test', ['$p1']);
    await receiveInvite(
      roomId,
      String(invite.event_id),
      { room_version: '11', event: wireOf(invite), invite_room_state: [] },
      'remote.test',
      deps,
    );
    // a third party's kick is honored by nobody
    const kick = await remoteEvent(roomId, srv, '11', {
      type: 'm.room.member',
      sender: `@rudy:${srv.name}`,
      state_key: '@dev:test',
      content: { membership: 'leave' },
      prev_events: ['$p2'],
      auth_events: [],
    });
    assertEquals(await acceptRescind(roomId, kick, deps), false);
    assertEquals(
      (await inviteFor(roomId, '@dev:test', deps))?.status,
      'pending',
    );
    // the inviter's own leave rescinds
    const rescind = await remoteEvent(roomId, srv, '11', {
      type: 'm.room.member',
      sender: `@zoe:${srv.name}`,
      state_key: '@dev:test',
      content: { membership: 'leave' },
      prev_events: ['$p3'],
      auth_events: [],
    });
    assertEquals(await acceptRescind(roomId, rescind, deps), true);
    const row = await inviteFor(roomId, '@dev:test', deps);
    assertEquals(row?.status, 'rejected');
    const rendered = JSON.parse(row!.eventJson) as Record<string, unknown>;
    assertEquals(
      (rendered.content as Record<string, unknown>).membership,
      'leave',
    );
  });
});
