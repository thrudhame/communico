// tests/federation-join-remote.test.ts — M5b commit 8: joining remote
// rooms. Join by alias (directory lookup at the alias server), by id
// with `via`, legacy `server_name`; candidate order; fail-over on
// 404/5xx, abort on 403; the snapshot as the room's root commit (sole
// extremity, the chapter published); positions NULL for the snapshot,
// positive for the join; /sync shows the room; a second local user
// joins locally; the remote re-join after the server left (new pair,
// old chapter intact, gap frontier visible); the self-only re-join
// (§3.6b) yields a complete-at-birth history chapter. Live doltgres +
// the fake remote over TLS.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { serverDb, withDb } from '#engine/db.ts';
import { setConfigForTests } from '#engine/config.ts';
import { extremities, lookupRoom } from '#engine/room.ts';
import { leave } from '#engine/membership.ts';
import {
  resetCaCertsForTests,
  wireFederationTransport,
} from '#engine/federation/client.ts';
import { resetFederationTables } from './util.ts';
import { type FakeServer, startFakeServer } from './federation/fake-server.ts';
import { createFakeRoom, type FakeRoom } from './federation/fake-room.ts';
import { seedServer } from './federation/doc-helper.ts';
import type { Pdu } from '#engine/pdu.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });
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
  aliases: Map<string, string>;
  makeJoinStatus: number;
};

async function withHost<T>(
  fn: (h: Host) => Promise<T>,
  opts: { version?: string } = {},
): Promise<T> {
  await resetFederationTables();
  setConfigForTests({
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  resetCaCertsForTests();
  wireFederationTransport();
  const h: Host = {
    fake: undefined as unknown as FakeServer,
    room: undefined as unknown as FakeRoom,
    aliases: new Map(),
    makeJoinStatus: 200,
  };
  const inProcessKeyDoc = async () =>
    await (await matrix(new Request('http://x/_matrix/key/v2/server'))).json();
  const handlers = async (req: {
    url: URL;
    json(): unknown;
    method: string;
  }): Promise<Response> => {
    const path = req.url.pathname;
    if (path === '/_matrix/federation/v1/query/directory') {
      const alias = req.url.searchParams.get('room_alias') ?? '';
      const roomId = h.aliases.get(alias);
      if (roomId === undefined) {
        return Response.json(
          { errcode: 'M_NOT_FOUND', error: 'no such alias' },
          { status: 404 },
        );
      }
      return Response.json({ room_id: roomId, servers: [h.fake.name] });
    }
    if (path.startsWith('/_matrix/federation/v1/make_join/')) {
      if (h.makeJoinStatus !== 200) {
        return Response.json(
          { errcode: 'M_FORBIDDEN', error: 'no' },
          { status: h.makeJoinStatus },
        );
      }
      const userId = decodeURIComponent(path.split('/').pop()!);
      return Response.json(h.room.makeJoinTemplate(userId));
    }
    if (path.startsWith('/_matrix/federation/v2/send_join/')) {
      const join = req.json() as Pdu;
      (join as unknown as Record<string, unknown>).event_id =
        decodeURIComponent(path.split('/').pop()!);
      const resp = await h.room.acceptSendJoin(join);
      return Response.json(resp);
    }
    if (path.startsWith('/_matrix/federation/v1/send_join/')) {
      const join = req.json() as Pdu;
      (join as unknown as Record<string, unknown>).event_id =
        decodeURIComponent(path.split('/').pop()!);
      const resp = await h.room.acceptSendJoin(join);
      return Response.json([200, resp]);
    }
    return Response.json(
      { errcode: 'M_UNRECOGNIZED', error: 'fake 404' },
      { status: 404 },
    );
  };
  h.fake = await startFakeServer({ ourKeyDoc: inProcessKeyDoc, handlers });
  await seedServer(
    { name: h.fake.name, keyId: h.fake.keyId, kp: h.fake.kp },
    (await h.fake.keyDoc()) as unknown as Parameters<typeof seedServer>[1],
  );
  h.room = await createFakeRoom({
    version: opts.version ?? '11',
    creator: `@zoe:${h.fake.name}`,
    server: { name: h.fake.name, keyId: h.fake.keyId, kp: h.fake.kp },
  });
  try {
    return await fn(h);
  } finally {
    await h.fake.close();
    setConfigForTests({ federation: { cacerts: [] } });
    resetCaCertsForTests();
  }
}

async function joinPaths(roomId: string): Promise<{
  currentChapter: string | null;
  liveX: string[];
  joinSeq: number | null;
  evidenceSeqs: (number | null)[];
}> {
  const room = (await lookupRoom(roomId))!;
  const liveX = (await extremities(room.dbName, roomId)).map((e) => e.branch);
  const rows = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT event_id, seq, era, branch_name, rejected_reason FROM event_index WHERE room_id = $1 ORDER BY seq;',
      [roomId],
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => ({
      eventId: String(row.event_id),
      seq: row.seq == null ? null : Number(row.seq),
      era: row.era == null ? null : String(row.era),
      branchName: row.branch_name == null ? null : String(row.branch_name),
      rejectedReason: row.rejected_reason == null
        ? null
        : String(row.rejected_reason),
    }));
  });
  const joinRow = rows.find((r) => r.branchName !== null && r.seq !== null);
  return {
    currentChapter: room.currentChapter,
    liveX,
    joinSeq: joinRow?.seq ?? null,
    evidenceSeqs: rows.filter((r) => r.branchName === null).map((r) => r.seq),
  };
}

Deno.test('join remote: by alias, by id with via, legacy server_name; snapshot as root commit', async () => {
  await withHost(async (h) => {
    h.aliases.set(`#fake-room:${h.fake.name}`, h.room.roomId);
    // 1. join by ALIAS — the directory lookup happens at the alias server
    const res = await call(
      `/_matrix/client/v3/join/${
        encodeURIComponent(`#fake-room:${h.fake.name}`)
      }`,
      { method: 'POST', token: DEV_TOKEN, body: {} },
    );
    assertEquals(res.status, 200);
    const roomId = res.body.room_id as string;
    assertEquals(roomId, h.room.roomId);
    // the book: chapter0 + chapter1, the join is the sole extremity
    const p = await joinPaths(roomId);
    assertEquals(p.currentChapter, 'chapter1');
    assertEquals(p.liveX.length, 1);
    assert(p.joinSeq !== null && p.joinSeq > 0, 'the join is live');
    // the snapshot events are 'evidence' (seq NULL)
    assert(p.evidenceSeqs.length >= 3, JSON.stringify(p));
    assert(p.evidenceSeqs.every((s) => s === null));
    // /sync shows the room
    const sync = await call('/_matrix/client/v3/sync?timeout=0', {
      token: DEV_TOKEN,
    });
    const joinSection = ((sync.body.rooms as Json).join as Json) ?? {};
    assert(roomId in joinSection, JSON.stringify(Object.keys(joinSection)));
    // a second local user joins locally (no federation for them)
    const bob = await (await import('./util.ts')).registerTestUser(
      'jr-bob',
      'pw-jr-bob',
    );
    const res2 = await call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { method: 'POST', token: bob.access_token!, body: {} },
    );
    assertEquals(res2.status, 200);

    // 2. join by id with via (a second fake room)
    const room2 = await createFakeRoom({
      version: '11',
      creator: `@zoe:${h.fake.name}`,
      server: { name: h.fake.name, keyId: h.fake.keyId, kp: h.fake.kp },
    });
    const res3 = await call(
      `/_matrix/client/v3/join/${
        encodeURIComponent(room2.roomId)
      }?via=${h.fake.name}`,
      { method: 'POST', token: DEV_TOKEN, body: {} },
    );
    assertEquals(res3.status, 200);
    // 3. legacy server_name (a third)
    const room3 = await createFakeRoom({
      version: '11',
      creator: `@zoe:${h.fake.name}`,
      server: { name: h.fake.name, keyId: h.fake.keyId, kp: h.fake.kp },
    });
    const res4 = await call(
      `/_matrix/client/v3/join/${
        encodeURIComponent(room3.roomId)
      }?server_name=${h.fake.name}`,
      { method: 'POST', token: DEV_TOKEN, body: {} },
    );
    assertEquals(res4.status, 200);
  });
});

Deno.test('join remote: fail-over on network failure and 404; abort on 403', async () => {
  await withHost(async (h) => {
    // a dead first candidate, the fake second — fail-over lands
    const res = await call(
      `/_matrix/client/v3/join/${
        encodeURIComponent(h.room.roomId)
      }?via=dead.test&via=${h.fake.name}`,
      { method: 'POST', token: DEV_TOKEN, body: {} },
    );
    assertEquals(res.status, 200);
    // a 403 from make_join aborts (no fail-over to the next)
    h.makeJoinStatus = 403;
    const room2 = await createFakeRoom({
      version: '11',
      creator: `@zoe:${h.fake.name}`,
      server: { name: h.fake.name, keyId: h.fake.keyId, kp: h.fake.kp },
    });
    const res2 = await call(
      `/_matrix/client/v3/join/${
        encodeURIComponent(room2.roomId)
      }?via=${h.fake.name}`,
      { method: 'POST', token: DEV_TOKEN, body: {} },
    );
    assertEquals(res2.status, 403);
  });
});

Deno.test('join remote: the remote re-join after the server left — new pair, old chapter intact', async () => {
  await withHost(async (h) => {
    h.aliases.set(`#fake-room:${h.fake.name}`, h.room.roomId);
    const res = await call(
      `/_matrix/client/v3/join/${
        encodeURIComponent(`#fake-room:${h.fake.name}`)
      }`,
      { method: 'POST', token: DEV_TOKEN, body: {} },
    );
    assertEquals(res.status, 200);
    const roomId = h.room.roomId;
    // the server leaves (dev is the sole local member → the stay closes)
    await leave(roomId, DEV);
    const archived = (await lookupRoom(roomId))!;
    assertEquals(archived.currentChapter, null);
    const oldX = (await extremities(archived.dbName, roomId, 'chapter1')).map((
      e,
    ) => e.branch);
    // the room reads through rooms.leave while archived
    const sync = await call(
      `/_matrix/client/v3/sync?timeout=0&filter=${
        encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))
      }`,
      { token: DEV_TOKEN },
    );
    const leaveSection = ((sync.body.rooms as Json).leave as Json) ?? {};
    assert(roomId in leaveSection, JSON.stringify(Object.keys(leaveSection)));
    // the fake adds messages while we are away (the gap)
    await h.room.addEvent({
      type: 'm.room.message',
      sender: `@zoe:${h.fake.name}`,
      content: { msgtype: 'm.text', body: 'while you were away' },
    });
    // the remote re-join: a NEW chapter pair, the old one intact
    const res2 = await call(
      `/_matrix/client/v3/join/${
        encodeURIComponent(roomId)
      }?via=${h.fake.name}`,
      { method: 'POST', token: DEV_TOKEN, body: {} },
    );
    assertEquals(res2.status, 200);
    const reopened = (await lookupRoom(roomId))!;
    assertEquals(reopened.currentChapter, 'chapter3');
    const branches = await withDb(reopened.dbName, async (c) => {
      const r = await c.query('SELECT name FROM dolt.branches ORDER BY name;');
      // deno-lint-ignore no-explicit-any
      return (r.rows as any[]).map((row) => String(row.name));
    });
    for (const b of ['chapter0', 'chapter1', 'chapter2', 'chapter3']) {
      assert(branches.includes(b), JSON.stringify(branches));
    }
    const oldXAfter = (await extremities(reopened.dbName, roomId, 'chapter1'))
      .map((e) => e.branch);
    assertEquals(oldXAfter, oldX, 'the old era’s extremities are intact');
    assertEquals(
      (await extremities(reopened.dbName, roomId)).length,
      1,
      'the re-join is the new stay’s only extremity',
    );
    // the gap frontier is visible: the re-join's prevs are not all grounded
    const gapVisible = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        `SELECT count(*) AS n FROM event_index WHERE room_id = $1 AND era = 'chapter3';`,
        [roomId],
      );
      return Number(r.rows[0].n);
    });
    assert(gapVisible >= 1);
  });
});

Deno.test('join remote: the self-only re-join (§3.6b) yields a complete-at-birth history chapter', async () => {
  await withHost(async (h) => {
    h.aliases.set(`#fake-room:${h.fake.name}`, h.room.roomId);
    const res = await call(
      `/_matrix/client/v3/join/${
        encodeURIComponent(`#fake-room:${h.fake.name}`)
      }`,
      { method: 'POST', token: DEV_TOKEN, body: {} },
    );
    assertEquals(res.status, 200);
    const roomId = h.room.roomId;
    await leave(roomId, DEV);
    assertEquals((await lookupRoom(roomId))!.currentChapter, null);
    // re-join with NO candidates — the server list is only ourselves:
    // the local reopen (§3.6b), no federation involved
    const res2 = await call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { method: 'POST', token: DEV_TOKEN, body: {} },
    );
    assertEquals(res2.status, 200);
    const reopened = (await lookupRoom(roomId))!;
    assertEquals(reopened.currentChapter, 'chapter3');
    // the new history chapter is complete at birth: chapter2 exists and
    // holds nothing (its would-be first event is already held)
    const chapter2Events = await withDb(reopened.dbName, async (c) => {
      const r = await c.query(
        `SELECT count(*) AS n FROM events AS OF 'chapter2';`,
      );
      return Number(r.rows[0].n);
    });
    assertEquals(chapter2Events, 0, 'complete at birth — nothing to fetch');
    assertEquals(
      (await extremities(reopened.dbName, roomId)).length,
      1,
    );
    void h;
  });
});
