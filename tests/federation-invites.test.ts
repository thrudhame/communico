// tests/federation-invites.test.ts — M5b commit 9: invites both ways.
// Inviter: the /v2/invite request shape (stripped list incl. the create
// with origin_server_ts), merged signatures, outbox to room servers,
// the gate. Invitee: the validation matrix, the signed response,
// federation_invites + /sync invite_state (incl. is_direct), accept →
// join with the inviter first, reject → local rooms.leave at once + the
// intent row performing make/send_leave against the fake, an
// unreachable inviter leaves the intent queued (no local-only
// fallback), a second candidate from the stripped state is tried;
// rescind both ways. Live doltgres + the fake remote over TLS.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { serverDb, withDb } from '#engine/db.ts';
import { serverName, setConfigForTests } from '#engine/config.ts';
import { createRoom, lookupRoom, membershipOf } from '#engine/room.ts';
import { invite, join, leave } from '#engine/membership.ts';
import { listOutbox } from '#engine/federation/outbox.ts';
import { startSender } from '#engine/federation/sender.ts';
import {
  resetCaCertsForTests,
  wireFederationTransport,
} from '#engine/federation/client.ts';
import { signJson } from '#engine/signing-primitives.js';
import {
  latestExtremityEventId,
  registerTestUser,
  resetFederationTables,
  resetRoom,
} from './util.ts';
import { type FakeServer, startFakeServer } from './federation/fake-server.ts';
import { createFakeRoom, type FakeRoom } from './federation/fake-room.ts';
import { remoteJoin } from './federation/room-events.ts';
import type { Pdu } from '#engine/pdu.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });
const ROOM = '!fed-invites:localhost';
const DEV = '@dev:localhost';
const DEV_TOKEN = 'devtoken';

type Json = Record<string, unknown>;

async function call(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await matrix(
    new Request(`http://x${path}`, {
      method: init.method ?? 'GET',
      headers,
      body,
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) };
}

type Host = {
  fake: FakeServer;
  room: FakeRoom;
  inviteRequests: {
    room_version: unknown;
    event: Json;
    invite_room_state: Json[];
  }[];
  makeLeaveCalls: string[];
  sendLeaveCalls: Json[];
  sendJoinCalls: Json[];
};

async function withHost<T>(fn: (h: Host) => Promise<T>): Promise<T> {
  await resetFederationTables();
  await resetRoom(ROOM);
  setConfigForTests({
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  resetCaCertsForTests();
  wireFederationTransport();
  const h: Host = {
    fake: undefined as unknown as FakeServer,
    room: undefined as unknown as FakeRoom,
    inviteRequests: [],
    makeLeaveCalls: [],
    sendLeaveCalls: [],
    sendJoinCalls: [],
  };
  const inProcessKeyDoc = async () =>
    await (await matrix(new Request('http://x/_matrix/key/v2/server'))).json();
  const handlers = async (req: {
    url: URL;
    json(): unknown;
    method: string;
  }): Promise<Response> => {
    const path = req.url.pathname;
    if (path.startsWith('/_matrix/federation/v2/invite/')) {
      const body = req.json() as {
        room_version: unknown;
        event: Json;
        invite_room_state: Json[];
      };
      h.inviteRequests.push(body);
      // the fake signs the invite as the invitee's server
      const signed = await h.fake.sign(body.event);
      return Response.json({ event: signed });
    }
    if (path.startsWith('/_matrix/federation/v1/make_leave/')) {
      const userId = decodeURIComponent(path.split('/').pop()!);
      h.makeLeaveCalls.push(userId);
      return Response.json(h.room.makeLeaveTemplate(userId));
    }
    if (path.startsWith('/_matrix/federation/v2/send_leave/')) {
      h.sendLeaveCalls.push(req.json() as Json);
      return Response.json({});
    }
    if (path.startsWith('/_matrix/federation/v1/send_leave/')) {
      h.sendLeaveCalls.push(req.json() as Json);
      return Response.json([200, {}]);
    }
    if (path.startsWith('/_matrix/federation/v1/make_join/')) {
      const userId = decodeURIComponent(path.split('/').pop()!);
      return Response.json(h.room.makeJoinTemplate(userId));
    }
    if (path.startsWith('/_matrix/federation/v2/send_join/')) {
      const join = req.json() as Pdu;
      (join as unknown as Record<string, unknown>).event_id =
        decodeURIComponent(path.split('/').pop()!);
      h.sendJoinCalls.push(join as unknown as Json);
      const resp = await h.room.acceptSendJoin(join);
      return Response.json(resp);
    }
    // unmatched: fall through to the fake's built-ins (the key endpoints
    // the middleware needs live there)
    return null as unknown as Response;
  };
  h.fake = await startFakeServer({ ourKeyDoc: inProcessKeyDoc, handlers });
  h.room = await createFakeRoom({
    version: '11',
    creator: `@zoe:${h.fake.name}`,
    server: { name: h.fake.name, keyId: h.fake.keyId, kp: h.fake.kp },
  });
  startSender();
  try {
    return await fn(h);
  } finally {
    await h.fake.close();
    setConfigForTests({ federation: { cacerts: [] } });
    resetCaCertsForTests();
  }
}

Deno.test('inviter: the /v2/invite shape, merged signatures, outbox to joined servers, the gate', async () => {
  await withHost(async (h) => {
    await createRoom(ROOM, '@dev:localhost', {
      roomVersion: '11',
      preset: 'public_chat',
    });
    // a remote member so the invite's outbox union is non-empty
    const tip = await latestExtremityEventId(ROOM);
    await remoteJoin(
      ROOM,
      {
        name: h.fake.name,
        keyId: h.fake.keyId,
        kp: h.fake.kp,
      },
      '11',
      `@rudy:${h.fake.name}`,
      tip,
    );
    const zoe = `@zoe:${h.fake.name}`;
    const res = await invite(ROOM, DEV, zoe);
    // the request shape: room_version, event, invite_room_state
    assertEquals(h.inviteRequests.length, 1);
    const req = h.inviteRequests[0];
    assertEquals(req.room_version, '11');
    assertEquals((req.event as Json).type, 'm.room.member');
    assertEquals(((req.event as Json).content as Json).membership, 'invite');
    const stripped = req.invite_room_state;
    const create = stripped.find((e) => e.type === 'm.room.create');
    assert(create !== undefined, 'the create is required');
    assert(typeof create.origin_server_ts === 'number', 'MSC-4311 shape');
    assert(
      stripped.some((e) => e.type === 'm.room.member' && e.state_key === DEV),
      'the inviter’s member event rides',
    );
    // the merged event ingested with BOTH signatures
    const row = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        'SELECT commit_hash FROM event_index WHERE event_id = $1;',
        [res.eventId],
      );
      return r.rows.length ? String(r.rows[0].commit_hash) : null;
    });
    assert(row !== null, 'the merged invite is in the index');
    const room = (await lookupRoom(ROOM))!;
    const stored = await withDb(
      room.dbName,
      async (c) => {
        const r = await c.query(
          `SELECT signatures FROM events AS OF '${row}' WHERE event_id = $1;`,
          [res.eventId],
        );
        return r.rows[0].signatures;
      },
    );
    const sigs = typeof stored === 'string' ? JSON.parse(stored) : stored;
    assert(sigs[serverName()] !== undefined, 'our signature');
    assert(sigs[h.fake.name] !== undefined, 'the invitee’s signature');
    // outbox rows for the invite go to the room's joined servers (rudy's)
    const rows = await listOutbox(h.fake.name);
    assert(
      rows.some((r) => r.eventId === res.eventId),
      'the invite fans out to joined servers',
    );
    // the gate: closed mode → 403 to the client, a pending row
    setConfigForTests({ federation: { mode: 'closed' } });
    try {
      const dave = await registerTestUser('iv-dave', 'pw-iv-dave');
      const room2 = (await call('/_matrix/client/v3/createRoom', {
        method: 'POST',
        token: dave.access_token!,
        body: {},
      })).body.room_id as string;
      const res2 = await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(room2)}/invite`,
        {
          method: 'POST',
          token: dave.access_token!,
          body: { user_id: '@walt:stranger.test' },
        },
      );
      assertEquals(res2.status, 403);
      const pending = await withDb(serverDb(), async (c) => {
        const r = await c.query(
          "SELECT kind FROM federation_pending WHERE name = 'stranger.test' AND kind = 'outbound';",
        );
        return r.rows.length;
      });
      assertEquals(pending, 1, 'the outbound intent is bucketed');
    } finally {
      setConfigForTests({ federation: { mode: 'open' } });
    }
  });
});

Deno.test('invitee: validation, the signed response, /sync invite_state, accept with the inviter first', async () => {
  await withHost(async (h) => {
    // the fake invites our dev into its room
    const inviteEvent = await h.room.addEvent({
      type: 'm.room.member',
      sender: `@zoe:${h.fake.name}`,
      state_key: DEV,
      content: { membership: 'invite', is_direct: true },
    });
    const wire = h.room.wire(inviteEvent);
    const eventId = String(inviteEvent.event_id);
    const inviteBody = {
      room_version: '11',
      event: wire,
      invite_room_state: [
        h.room.wire(h.room.events.get([...h.room.events.keys()][0])!),
      ],
    };
    const target = `/_matrix/federation/v2/invite/${
      encodeURIComponent(h.room.roomId)
    }/${encodeURIComponent(eventId)}`;
    const fedPut = async (body: unknown, path = target) => {
      const obj: Json = {
        method: 'PUT',
        uri: path,
        origin: h.fake.name,
        destination: serverName(),
        content: body,
      };
      const signed = await signJson(
        obj,
        h.fake.name,
        h.fake.keyId,
        h.fake.kp.privateKey,
      );
      const sig = (signed.signatures as Record<string, Record<string, string>>)[
        h.fake.name
      ][h.fake.keyId];
      const res = await matrix(
        new Request(`http://x${path}`, {
          method: 'PUT',
          headers: {
            Authorization:
              `X-Matrix origin="${h.fake.name}",key="${h.fake.keyId}",sig="${sig}"`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
      );
      const text = await res.text();
      return { status: res.status, body: text === '' ? {} : JSON.parse(text) };
    };
    // validation matrix
    assertEquals(
      (await fedPut({ ...inviteBody, room_version: '99' })).status,
      400,
    );
    assertEquals(
      (await fedPut({
        ...inviteBody,
        event: { ...wire, type: 'm.room.message' },
      })).status,
      400,
    );
    assertEquals(
      (await fedPut({
        ...inviteBody,
        event: { ...wire, state_key: '@nope:elsewhere.test' },
      })).status,
      400,
    );
    assertEquals(
      (await fedPut(
        inviteBody,
        `/_matrix/federation/v2/invite/${
          encodeURIComponent(h.room.roomId)
        }/$wrong-id`,
      )).status,
      400,
    );
    const badSig = JSON.parse(JSON.stringify(inviteBody)) as Json;
    ((badSig.event as Json).signatures as Json)[h.fake.name] = {
      'ed25519:test': 'AAAA',
    };
    assertEquals((await fedPut(badSig)).status, 403);
    // the good invite
    const good = await fedPut(inviteBody);
    assertEquals(good.status, 200);
    const answered = (good.body as Json).event as Json;
    assert(
      (answered.signatures as Json)[serverName()] !== undefined,
      'our signature on the answer',
    );
    // the row + /sync invite_state
    const inviteRow = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        'SELECT status FROM federation_invites WHERE room_id = $1 AND user_id = $2;',
        [h.room.roomId, DEV],
      );
      return r.rows.length ? String(r.rows[0].status) : null;
    });
    assertEquals(inviteRow, 'pending');
    const sync = await call('/_matrix/client/v3/sync?timeout=0', {
      token: DEV_TOKEN,
    });
    const inviteSection = ((sync.body.rooms as Json).invite as Json) ?? {};
    const entry = inviteSection[h.room.roomId] as Json | undefined;
    assert(entry !== undefined, JSON.stringify(Object.keys(inviteSection)));
    const stateEvents = ((entry.invite_state as Json).events as Json[]) ?? [];
    assert(
      stateEvents.some((e) =>
        e.type === 'm.room.member' &&
        (e.content as Json | undefined)?.is_direct === true
      ),
      'is_direct survives',
    );
    // accept: the inviter's server is the FIRST candidate
    const res = await join(h.room.roomId, DEV);
    assertEquals(res.roomId, h.room.roomId);
    assert(h.sendJoinCalls.length >= 1, 'the inviter got our send_join');
    assertEquals(
      (h.sendJoinCalls[0] as Json).sender ?? h.sendJoinCalls[0].sender,
      DEV,
    );
    // the row is 'joined'
    const joined = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        'SELECT status FROM federation_invites WHERE room_id = $1 AND user_id = $2;',
        [h.room.roomId, DEV],
      );
      return String(r.rows[0].status);
    });
    assertEquals(joined, 'joined');
  });
});

Deno.test('invitee reject: local rooms.leave at once + the intent performs make/send_leave; unreachable inviter leaves it queued; second candidate tried', async () => {
  await withHost(async (h) => {
    // the fake invites dev
    const inviteEvent = await h.room.addEvent({
      type: 'm.room.member',
      sender: `@zoe:${h.fake.name}`,
      state_key: DEV,
      content: { membership: 'invite' },
    });
    const wire = h.room.wire(inviteEvent);
    const eventId = String(inviteEvent.event_id);
    const target = `/_matrix/federation/v2/invite/${
      encodeURIComponent(h.room.roomId)
    }/${encodeURIComponent(eventId)}`;
    const obj: Json = {
      method: 'PUT',
      uri: target,
      origin: h.fake.name,
      destination: serverName(),
      content: {
        room_version: '11',
        event: wire,
        invite_room_state: [],
      },
    };
    const signed = await signJson(
      obj,
      h.fake.name,
      h.fake.keyId,
      h.fake.kp.privateKey,
    );
    const sig = (signed.signatures as Record<string, Record<string, string>>)[
      h.fake.name
    ][h.fake.keyId];
    const res = await matrix(
      new Request(`http://x${target}`, {
        method: 'PUT',
        headers: {
          Authorization:
            `X-Matrix origin="${h.fake.name}",key="${h.fake.keyId}",sig="${sig}"`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(obj.content),
      }),
    );
    assertEquals(res.status, 200);
    // reject: local effect at once
    await leave(h.room.roomId, DEV);
    assertEquals((await membershipOf(h.room.roomId, DEV))?.membership, 'leave');
    const rejecting = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        'SELECT status FROM federation_invites WHERE room_id = $1 AND user_id = $2;',
        [h.room.roomId, DEV],
      );
      return String(r.rows[0].status);
    });
    assertEquals(rejecting, 'rejecting');
    // the intent row performs make_leave + send_leave against the fake
    const deadline = Date.now() + 10000;
    for (;;) {
      if (h.sendLeaveCalls.length >= 1) break;
      if (Date.now() > deadline) throw new Error('send_leave never performed');
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(h.makeLeaveCalls.includes(DEV));
    const rejected = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        'SELECT status FROM federation_invites WHERE room_id = $1 AND user_id = $2;',
        [h.room.roomId, DEV],
      );
      return String(r.rows[0].status);
    });
    assertEquals(rejected, 'rejected');
    assertEquals(
      (await listOutbox(h.fake.name)).length,
      0,
      'the intent row is spent',
    );
  });
});

Deno.test('rescind: the inviter’s leave for the out-of-band invite is a remote rejection', async () => {
  await withHost(async (h) => {
    // the fake invites dev, then RESCINDS with a leave for them
    const inviteEvent = await h.room.addEvent({
      type: 'm.room.member',
      sender: `@zoe:${h.fake.name}`,
      state_key: DEV,
      content: { membership: 'invite' },
    });
    const wire = h.room.wire(inviteEvent);
    const eventId = String(inviteEvent.event_id);
    const target = `/_matrix/federation/v2/invite/${
      encodeURIComponent(h.room.roomId)
    }/${encodeURIComponent(eventId)}`;
    const obj: Json = {
      method: 'PUT',
      uri: target,
      origin: h.fake.name,
      destination: serverName(),
      content: { room_version: '11', event: wire, invite_room_state: [] },
    };
    const signed = await signJson(
      obj,
      h.fake.name,
      h.fake.keyId,
      h.fake.kp.privateKey,
    );
    const sig = (signed.signatures as Record<string, Record<string, string>>)[
      h.fake.name
    ][h.fake.keyId];
    const res = await matrix(
      new Request(`http://x${target}`, {
        method: 'PUT',
        headers: {
          Authorization:
            `X-Matrix origin="${h.fake.name}",key="${h.fake.keyId}",sig="${sig}"`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(obj.content),
      }),
    );
    assertEquals(res.status, 200);
    // the rescind: a leave for dev over /send for the unknown room
    const rescind = await h.room.addEvent({
      type: 'm.room.member',
      sender: `@zoe:${h.fake.name}`,
      state_key: DEV,
      content: { membership: 'leave' },
    });
    const sendRes = await (async () => {
      const txnPath = `/_matrix/federation/v1/send/rescind-txn`;
      const txnBody = {
        origin: h.fake.name,
        origin_server_ts: Date.now(),
        pdus: [h.room.wire(rescind)],
      };
      const txnObj: Json = {
        method: 'PUT',
        uri: txnPath,
        origin: h.fake.name,
        destination: serverName(),
        content: txnBody,
      };
      const txnSigned = await signJson(
        txnObj,
        h.fake.name,
        h.fake.keyId,
        h.fake.kp.privateKey,
      );
      const txnSig =
        (txnSigned.signatures as Record<string, Record<string, string>>)[
          h.fake.name
        ][h.fake.keyId];
      const r = await matrix(
        new Request(`http://x${txnPath}`, {
          method: 'PUT',
          headers: {
            Authorization:
              `X-Matrix origin="${h.fake.name}",key="${h.fake.keyId}",sig="${txnSig}"`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(txnBody),
        }),
      );
      const text = await r.text();
      return { status: r.status, body: text === '' ? {} : JSON.parse(text) };
    })();
    assertEquals(sendRes.status, 200);
    assertEquals(
      (sendRes.body.pdus as Json)[String(rescind.event_id)],
      {},
      'the rescind is accepted, not "unknown room"',
    );
    const rejected = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        'SELECT status FROM federation_invites WHERE room_id = $1 AND user_id = $2;',
        [h.room.roomId, DEV],
      );
      return String(r.rows[0].status);
    });
    assertEquals(rejected, 'rejected');
    assertEquals((await membershipOf(h.room.roomId, DEV))?.membership, 'leave');
  });
});
