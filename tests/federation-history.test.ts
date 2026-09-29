// tests/federation-history.test.ts — M5b commit 10: the reading walk
// and backfill into even chapters. /messages backward from a fresh join
// → chapter1, then chapter0 (one backfill per call; commits
// parent-on-child, branch_pos = commit position), end omitted at the
// create event; the re-join story (the walk reads 3, 2, 1, 0 in
// chronological order — Complement's assertion); a two-page fetch lands
// page 2 on page 1's tip; c<n>_<offset> tokens round-trip and a legacy
// s<n> works; history rows have seq NULL, branch_pos, era; /sync never
// returns history. Live doltgres + the fake remote over TLS.
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

type Host = { fake: FakeServer; room: FakeRoom };

async function withHost<T>(fn: (h: Host) => Promise<T>): Promise<T> {
  await resetFederationTables();
  setConfigForTests({
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  resetCaCertsForTests();
  wireFederationTransport();
  const h: Host = {
    fake: undefined as unknown as FakeServer,
    room: undefined as unknown as FakeRoom,
  };
  const inProcessKeyDoc = async () =>
    await (await matrix(new Request('http://x/_matrix/key/v2/server'))).json();
  const handlers = async (req: {
    url: URL;
    json(): unknown;
    method: string;
  }): Promise<Response> => {
    const path = req.url.pathname;
    if (path.startsWith('/_matrix/federation/v1/make_join/')) {
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
    if (path.startsWith('/_matrix/federation/v1/backfill/')) {
      const v = req.url.searchParams.getAll('v');
      const limit = Number(req.url.searchParams.get('limit') ?? '50');
      const pdus = h.room.backfill(v, limit);
      return Response.json({
        origin: h.fake.name,
        origin_server_ts: Date.now(),
        pdus: pdus.map((p) => h.room.wire(p)),
      });
    }
    if (path.startsWith('/_matrix/federation/v1/state_ids/')) {
      const eventId = req.url.searchParams.get('event_id') ?? '';
      return Response.json(h.room.stateIds(eventId));
    }
    if (path.startsWith('/_matrix/federation/v1/event/')) {
      const eventId = decodeURIComponent(
        path.slice('/_matrix/federation/v1/event/'.length),
      );
      const pdu = h.room.event(eventId);
      if (pdu === null) {
        return Response.json(
          { errcode: 'M_NOT_FOUND', error: 'not here' },
          { status: 404 },
        );
      }
      return Response.json({
        origin: h.fake.name,
        origin_server_ts: Date.now(),
        pdus: [h.room.wire(pdu)],
      });
    }
    return null as unknown as Response;
  };
  h.fake = await startFakeServer({ ourKeyDoc: inProcessKeyDoc, handlers });
  await seedServer(
    { name: h.fake.name, keyId: h.fake.keyId, kp: h.fake.kp },
    (await h.fake.keyDoc()) as never,
  );
  h.room = await createFakeRoom({
    version: '11',
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

async function joinRemote(h: Host): Promise<string> {
  const res = await call(
    `/_matrix/client/v3/join/${
      encodeURIComponent(h.room.roomId)
    }?via=${h.fake.name}`,
    { method: 'POST', token: DEV_TOKEN, body: {} },
  );
  assertEquals(res.status, 200);
  return h.room.roomId;
}

async function messagesBackward(
  roomId: string,
  from?: string,
  limit = 5,
): Promise<{ bodies: (string | undefined)[]; end?: string; types: string[] }> {
  const res = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/messages?dir=b&limit=${limit}${
      from !== undefined ? `&from=${encodeURIComponent(from)}` : ''
    }`,
    { token: DEV_TOKEN },
  );
  assertEquals(res.status, 200);
  const chunk = (res.body.chunk as Json[]) ?? [];
  return {
    bodies: chunk.map((e) =>
      (e.content as Json | undefined)?.body as string | undefined
    ),
    end: res.body.end as string | undefined,
    types: chunk.map((e) => String(e.type)),
  };
}

Deno.test('history: the walk + backfill into chapter0; end omitted at the create', async () => {
  await withHost(async (h) => {
    // the fake's room has 12 messages BEFORE we arrive
    for (let i = 1; i <= 12; i++) {
      await h.room.addEvent({
        type: 'm.room.message',
        sender: `@zoe:${h.fake.name}`,
        content: { msgtype: 'm.text', body: `m${i}` },
      });
    }
    const roomId = await joinRemote(h);
    // page 1: the join + a backfill into chapter0
    const p1 = await messagesBackward(roomId, undefined, 5);
    assertEquals(p1.types[0], 'm.room.member', JSON.stringify(p1.types));
    assert(p1.bodies.includes('m12'), JSON.stringify(p1.bodies));
    assert(p1.bodies.includes('m9'), JSON.stringify(p1.bodies));
    // the walk kept going across the frontier (one backfill per call)
    const p2 = await messagesBackward(roomId, p1.end, 5);
    assert(p2.bodies.includes('m7'), JSON.stringify(p2.bodies));
    const p3 = await messagesBackward(roomId, p2.end, 10);
    assert(p3.bodies.includes('m1'), JSON.stringify(p3.bodies));
    // the walk ends at the create event — end omitted
    assertEquals(p3.end, undefined, JSON.stringify(p3));
    assert(p3.types.includes('m.room.create'), JSON.stringify(p3.types));
    // the history rows: seq NULL, branch_pos, era, on chapter0
    const rows = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        `SELECT seq, branch_name, branch_pos, era FROM event_index
         WHERE room_id = $1 AND branch_name = 'chapter0' ORDER BY branch_pos;`,
        [roomId],
      );
      // deno-lint-ignore no-explicit-any
      return (r.rows as any[]).map((row) => ({
        seq: row.seq,
        branchName: String(row.branch_name),
        branchPos: Number(row.branch_pos),
        era: String(row.era),
      }));
    });
    assert(rows.length >= 10, JSON.stringify(rows.length));
    assert(rows.every((r) => r.seq === null), 'history rows have seq NULL');
    assertEquals(rows[0].branchPos, 0, 'branch_pos 0 = the most recent');
    assert(
      rows.every((r) => r.era === 'chapter1'),
      'era = the discovering stay',
    );
    // /sync never returns history
    const sync = await call('/_matrix/client/v3/sync?timeout=0', {
      token: DEV_TOKEN,
    });
    const joinSection =
      ((sync.body.rooms as Json).join as Json)[roomId] as Json;
    const timeline = ((joinSection.timeline as Json).events as Json[]) ?? [];
    assert(
      !timeline.some((e) =>
        typeof (e as Json).type === 'string' &&
        ((e as Json).content as Json | undefined)?.body === 'm1'
      ),
      'history is never news',
    );
  });
});

Deno.test('history: the re-join story — the walk reads 3, 2, 1, 0 in chronological order', async () => {
  await withHost(async (h) => {
    for (let i = 1; i <= 4; i++) {
      await h.room.addEvent({
        type: 'm.room.message',
        sender: `@zoe:${h.fake.name}`,
        content: { msgtype: 'm.text', body: `before${i}` },
      });
    }
    const roomId = await joinRemote(h);
    // our own message on the first stay
    await call(
      `/_matrix/client/v3/rooms/${
        encodeURIComponent(roomId)
      }/send/m.room.message/stay1`,
      {
        method: 'PUT',
        token: DEV_TOKEN,
        body: { msgtype: 'm.text', body: 'stay1' },
      },
    );
    // the server leaves (sole local member → close), the fake adds the gap
    await leave(roomId, '@dev:localhost');
    assertEquals((await lookupRoom(roomId))!.currentChapter, null);
    for (let i = 1; i <= 3; i++) {
      await h.room.addEvent({
        type: 'm.room.message',
        sender: `@zoe:${h.fake.name}`,
        content: { msgtype: 'm.text', body: `gap${i}` },
      });
    }
    // the remote re-join
    const res = await call(
      `/_matrix/client/v3/join/${
        encodeURIComponent(roomId)
      }?via=${h.fake.name}`,
      { method: 'POST', token: DEV_TOKEN, body: {} },
    );
    assertEquals(res.status, 200);
    assertEquals((await lookupRoom(roomId))!.currentChapter, 'chapter3');
    // the walk: chapter3 (the re-join) → chapter2 (the gap, fetched) →
    // chapter1 (the old stay) → chapter0 → the create — chronological
    const pages: (string | undefined)[] = [];
    let from: string | undefined;
    for (let page = 0; page < 8; page++) {
      const r = await messagesBackward(roomId, from, 4);
      pages.push(...r.bodies);
      if (r.end === undefined) break;
      from = r.end;
    }
    const seen = pages.filter((b) => b !== undefined) as string[];
    // chronological order across all four chapters (backward = newest first)
    const gapIdx = seen.findIndex((b) => b === 'gap3');
    const gap1Idx = seen.findIndex((b) => b === 'gap1');
    const stayIdx = seen.findIndex((b) => b === 'stay1');
    const beforeIdx = seen.findIndex((b) => b === 'before1');
    assert(gapIdx >= 0 && gap1Idx > gapIdx, JSON.stringify(seen));
    assert(stayIdx > gap1Idx, JSON.stringify(seen));
    assert(beforeIdx > stayIdx, JSON.stringify(seen));
    // the gap fetched into chapter2 until it OVERLAPPED chapter1 (the
    // chapter is complete — the create reached or the overlap held)
    const ch2 = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        `SELECT count(*) AS n FROM event_index WHERE room_id = $1 AND branch_name = 'chapter2';`,
        [roomId],
      );
      return Number(r.rows[0].n);
    });
    assert(ch2 >= 3, `chapter2 holds the gap: ${ch2}`);
    // extremities ignores the old eras
    const room = (await lookupRoom(roomId))!;
    assertEquals((await extremities(room.dbName, roomId)).length, 1);
  });
});

Deno.test('history: a two-page fetch lands page 2 on page 1’s tip; tokens round-trip; legacy s<n> works', async () => {
  await withHost(async (h) => {
    for (let i = 1; i <= 8; i++) {
      await h.room.addEvent({
        type: 'm.room.message',
        sender: `@zoe:${h.fake.name}`,
        content: { msgtype: 'm.text', body: `p${i}` },
      });
    }
    const roomId = await joinRemote(h);
    // force the two pages by capping the batch: backfillbatch = 3
    setConfigForTests({ federation: { backfillbatch: 3 } });
    try {
      const p1 = await messagesBackward(roomId, undefined, 2);
      const p2 = await messagesBackward(roomId, p1.end, 4);
      const p3 = await messagesBackward(roomId, p2.end, 4);
      const all = [...p1.bodies, ...p2.bodies, ...p3.bodies].filter((b) =>
        b !== undefined
      ) as string[];
      // page 2 landed on page 1's tip with parentage intact — a
      // continuous newest-first walk across both fetches
      for (let i = 8; i >= 1; i--) {
        assert(all.includes(`p${i}`), `p${i} in ${JSON.stringify(all)}`);
      }
      // tokens: the end token of page 1 round-trips to the same place
      const again = await messagesBackward(roomId, p1.end, 2);
      assertEquals(again.bodies, p2.bodies.slice(0, 2));
      // a legacy s<n> token: the join's seq maps by lookup
      const joinSeq = await withDb(serverDb(), async (c) => {
        const r = await c.query(
          `SELECT seq FROM event_index WHERE room_id = $1 AND era = 'chapter1' AND seq IS NOT NULL ORDER BY seq DESC LIMIT 1;`,
          [roomId],
        );
        return Number(r.rows[0].seq);
      });
      const legacy = await call(
        `/_matrix/client/v3/rooms/${
          encodeURIComponent(roomId)
        }/messages?dir=b&limit=2&from=s${joinSeq}`,
        { token: DEV_TOKEN },
      );
      assertEquals(legacy.status, 200);
      assert((legacy.body.chunk as Json[]).length >= 1);
    } finally {
      setConfigForTests({ federation: { backfillbatch: 50 } });
    }
  });
});
