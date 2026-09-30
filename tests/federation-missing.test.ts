// tests/federation-missing.test.ts — M5b commit 5: the missing-prev
// chain. The get_missing_events request shape (earliest = our
// extremities); answered events land 'after' in depth order; an
// ungrounded prev never grounds its child; re-check when the parent
// arrives BY ANY ROUTE (no re-send); re-send re-checks too
// (TestUnrejectRejectedEvents shape); expiry removes the placeholder;
// /state_ids + /event packs the prev with its fetched state. Live
// doltgres + the fake remote over TLS.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { serverDb, withDb } from '#engine/db.ts';
import { setConfigForTests } from '#engine/config.ts';
import { createRoom, groundingOf, stateAtSeq } from '#engine/room.ts';
import { ingestEvent, sweepExpiredPlaceholders } from '#engine/ingest.ts';
import { storeUngroundedLocked, withRoomLock } from '#engine/ingest.ts';
import {
  resetCaCertsForTests,
  wireFederationTransport,
} from '#engine/federation/client.ts';
import { fetchMissingPrevs } from '#engine/federation/missing.ts';
import {
  latestExtremityEventId,
  resetFederationTables,
  resetRoom,
} from './util.ts';
import { type FakeServer, startFakeServer } from './federation/fake-server.ts';
import {
  createIdOf,
  remoteEvent,
  remoteJoin,
} from './federation/room-events.ts';
import type { Pdu } from '#engine/pdu.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });
const ROOM = '!fed-missing:localhost';

async function inProcessKeyDoc(): Promise<unknown> {
  const res = await matrix(new Request('http://x/_matrix/key/v2/server'));
  return await res.json();
}

type MissingReq = {
  earliest_events: string[];
  latest_events: string[];
  limit: number;
};

type Setup = {
  fake: FakeServer;
  missingRequests: MissingReq[];
  answer: { events: Pdu[] };
  stateIds: Map<string, { pdu_ids: string[]; auth_chain_ids: string[] }>;
  eventAnswers: Map<string, Pdu | null>;
};

function wireOf(pdu: Pdu): Record<string, unknown> {
  const out = { ...(pdu as unknown as Record<string, unknown>) };
  delete out.event_id;
  delete out.unsigned;
  return out;
}

async function withSetup<T>(fn: (s: Setup) => Promise<T>): Promise<T> {
  await resetFederationTables();
  await resetRoom(ROOM);
  setConfigForTests({
    federation: {
      cacerts: ['tests/fixtures/tls/ca.crt'],
      missingwaitms: 200,
    },
  });
  resetCaCertsForTests();
  wireFederationTransport();
  const missingRequests: MissingReq[] = [];
  const s: Setup = {
    fake: undefined as unknown as FakeServer,
    missingRequests,
    answer: { events: [] },
    stateIds: new Map(),
    eventAnswers: new Map(),
  };
  const handlers = (req: {
    url: URL;
    json(): unknown;
  }): Response | null => {
    const path = req.url.pathname;
    if (path.startsWith(`/_matrix/federation/v1/get_missing_events/`)) {
      missingRequests.push(req.json() as MissingReq);
      return Response.json({ events: s.answer.events.map(wireOf) });
    }
    if (path.startsWith(`/_matrix/federation/v1/state_ids/`)) {
      const eventId = req.url.searchParams.get('event_id') ?? '';
      return Response.json(
        s.stateIds.get(eventId) ?? { pdu_ids: [], auth_chain_ids: [] },
      );
    }
    if (path.startsWith(`/_matrix/federation/v1/event/`)) {
      const eventId = decodeURIComponent(
        path.slice('/_matrix/federation/v1/event/'.length),
      );
      const pdu = s.eventAnswers.get(eventId);
      if (pdu === undefined || pdu === null) {
        return Response.json(
          { errcode: 'M_NOT_FOUND', error: 'not here' },
          { status: 404 },
        );
      }
      return Response.json({
        origin: s.fake.name,
        origin_server_ts: Date.now(),
        pdus: [wireOf(pdu)],
      });
    }
    return null;
  };
  s.fake = await startFakeServer({ ourKeyDoc: inProcessKeyDoc, handlers });
  // the room with the fake's user joined (the delivery origin)
  await createRoom(ROOM, '@dev:localhost', {
    roomVersion: '11',
    preset: 'public_chat',
  });
  const tip = await latestExtremityEventId(ROOM);
  await remoteJoin(
    ROOM,
    {
      name: s.fake.name,
      keyId: s.fake.keyId,
      kp: s.fake.kp,
    },
    '11',
    `@rudy:${s.fake.name}`,
    tip,
  );
  try {
    return await fn(s);
  } finally {
    await s.fake.close();
    setConfigForTests({ federation: { cacerts: [], missingwaitms: 750 } });
    resetCaCertsForTests();
  }
}

async function remoteMsg(
  fake: FakeServer,
  body: string,
  prevIds: string[],
  opts: { depth?: number; sender?: string } = {},
): Promise<Pdu> {
  return await remoteEvent(
    ROOM,
    {
      name: fake.name,
      keyId: fake.keyId,
      kp: fake.kp,
    },
    '11',
    {
      type: 'm.room.message',
      sender: opts.sender ?? `@rudy:${fake.name}`,
      content: { msgtype: 'm.text', body },
      prev_events: prevIds,
      depth: opts.depth,
    },
  );
}

async function waitGrounding(
  eventId: string,
  want: 'own' | 'placeholder' | 'unknown' | 'evidence',
  ms = 5000,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const g = await groundingOf(ROOM, eventId);
    if (g === want) return;
    if (Date.now() > deadline) {
      throw new Error(`groundingOf(${eventId}) = ${g}, wanted ${want}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

Deno.test('missing: request shape (earliest = our extremities); answers land in depth order', async () => {
  await withSetup(async ({ fake, missingRequests, answer }) => {
    const tip = await latestExtremityEventId(ROOM);
    const p0 = await remoteMsg(fake, 'p0', [tip], { depth: 50 });
    const p1 = await remoteMsg(fake, 'p1', [String(p0.event_id)], {
      depth: 51,
    });
    answer.events = [p1, p0]; // deliberately out of order
    const pushed = await remoteMsg(fake, 'pushed', [String(p1.event_id)], {
      depth: 52,
    });
    await fetchMissingPrevs(ROOM, pushed, fake.name, {
      until: Date.now() + 8000,
    });
    // the request shape
    assertEquals(missingRequests.length, 1);
    assertEquals(missingRequests[0].latest_events, [String(pushed.event_id)]);
    assert(missingRequests[0].earliest_events.length >= 1);
    assertEquals(missingRequests[0].limit, 10);
    // the answered events landed 'after' in depth order (p0 then p1)
    const seqOf = async (id: string) =>
      await withDb(serverDb(), async (c) => {
        const r = await c.query(
          'SELECT seq FROM event_index WHERE event_id = $1;',
          [id],
        );
        return r.rows.length && r.rows[0].seq != null
          ? Number(r.rows[0].seq)
          : null;
      });
    const s0 = await seqOf(String(p0.event_id));
    const s1 = await seqOf(String(p1.event_id));
    assert(s0 !== null && s1 !== null && s0 < s1, `${s0} < ${s1}`);
    // and the pushed event now ingests cleanly
    await ingestEvent(ROOM, pushed, {
      remote: { origin: fake.name, position: 'after' },
    });
    assertEquals(await groundingOf(ROOM, String(pushed.event_id)), 'own');
  });
});

Deno.test('missing: an ungrounded prev never grounds its child; the parent’s arrival re-checks', async () => {
  await withSetup(async ({ fake }) => {
    const tip = await latestExtremityEventId(ROOM);
    const parent = await remoteMsg(fake, 'parent', [tip], { depth: 50 });
    const orphan = await remoteMsg(fake, 'orphan', [String(parent.event_id)], {
      depth: 51,
    });
    const child = await remoteMsg(fake, 'child', [String(orphan.event_id)], {
      depth: 52,
    });
    // orphan + its child both stored 'ungrounded' — the child cites an
    // UNGROUNDED prev, which never grounds it
    await withRoomLock(ROOM, async () => {
      await storeUngroundedLocked(ROOM, orphan, fake.name);
      await storeUngroundedLocked(ROOM, child, fake.name);
    });
    assertEquals(
      await groundingOf(ROOM, String(orphan.event_id)),
      'placeholder',
    );
    assertEquals(
      await groundingOf(ROOM, String(child.event_id)),
      'placeholder',
    );
    // the parent arrives BY ANY ROUTE (a plain ingest, no re-send) — the
    // orphan is re-checked and accepted with a NEW seq …
    await ingestEvent(ROOM, parent, {
      remote: { origin: fake.name, position: 'after' },
    });
    await waitGrounding(String(orphan.event_id), 'own');
    // … and ITS waiters re-check in turn
    await waitGrounding(String(child.event_id), 'own');
    const row = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        'SELECT seq, rejected_reason FROM event_index WHERE event_id = $1;',
        [String(orphan.event_id)],
      );
      return r.rows[0];
    });
    assert(row.seq !== null && Number(row.seq) > 0, JSON.stringify(row));
    assertEquals(row.rejected_reason, null);
    // the waiting rows are spent
    const waiting = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        'SELECT count(*) AS n FROM event_index_waiting WHERE event_id = ANY($1);',
        [[String(orphan.event_id), String(child.event_id)]],
      );
      return Number(r.rows[0].n);
    });
    assertEquals(waiting, 0);
  });
});

Deno.test('missing: a re-sent orphan is accepted once its prev has arrived (TestUnrejectRejectedEvents shape)', async () => {
  await withSetup(async ({ fake }) => {
    const tip = await latestExtremityEventId(ROOM);
    const parent = await remoteMsg(fake, 'parent', [tip], { depth: 50 });
    const orphan = await remoteMsg(fake, 'orphan', [String(parent.event_id)], {
      depth: 51,
    });
    await withRoomLock(ROOM, async () => {
      await storeUngroundedLocked(ROOM, orphan, fake.name);
    });
    assertEquals(
      await groundingOf(ROOM, String(orphan.event_id)),
      'placeholder',
    );
    // the parent lands, THEN the orphan is re-sent — accepted
    await ingestEvent(ROOM, parent, {
      remote: { origin: fake.name, position: 'after' },
    });
    const res = await ingestEvent(ROOM, orphan, {
      remote: { origin: fake.name, position: 'after' },
    });
    assertEquals(res.event_id, String(orphan.event_id));
    await waitGrounding(String(orphan.event_id), 'own');
  });
});

Deno.test('missing: /state_ids + /event packs the prev with its fetched state', async () => {
  await withSetup(async ({ fake, stateIds, eventAnswers }) => {
    const tip = await latestExtremityEventId(ROOM);
    // the fake's story: prev is a member event for a user we never saw
    const prev = await remoteEvent(
      ROOM,
      {
        name: fake.name,
        keyId: fake.keyId,
        kp: fake.kp,
      },
      '11',
      {
        type: 'm.room.member',
        sender: `@zoe:${fake.name}`,
        state_key: `@zoe:${fake.name}`,
        content: { membership: 'join' },
        prev_events: [tip],
        depth: 50,
      },
    );
    // the state at prev: the room's FULL current state (held rows are
    // skipped by the unknown filter) + a state event we do NOT hold
    const fullState = (await stateAtSeq(ROOM, null)) ?? [];
    const topic = await remoteEvent(
      ROOM,
      {
        name: fake.name,
        keyId: fake.keyId,
        kp: fake.kp,
      },
      '11',
      {
        type: 'm.room.topic',
        sender: `@zoe:${fake.name}`,
        state_key: '',
        content: { topic: 'on the wire' },
        prev_events: [tip],
        depth: 49,
      },
    );
    stateIds.set(String(prev.event_id), {
      pdu_ids: [...fullState.map((r) => r.eventId), String(topic.event_id)],
      auth_chain_ids: [
        fullState.find((r) => r.type === 'm.room.create')!.eventId,
        fullState.find((r) => r.type === 'm.room.power_levels')!.eventId,
      ],
    });
    eventAnswers.set(String(prev.event_id), prev);
    eventAnswers.set(String(topic.event_id), topic);
    const pushed = await remoteMsg(fake, 'pushed', [String(prev.event_id)], {
      depth: 51,
    });
    await fetchMissingPrevs(ROOM, pushed, fake.name, {
      until: Date.now() + 8000,
    });
    // the prev landed live with the fetched state as its before-state
    assertEquals(await groundingOf(ROOM, String(prev.event_id)), 'own');
    // the pushed event ingests against it
    await ingestEvent(ROOM, pushed, {
      remote: { origin: fake.name, position: 'after' },
    });
    assertEquals(await groundingOf(ROOM, String(pushed.event_id)), 'own');
    // the fetched evidence row (the topic we did not hold): seq NULL,
    // branch NULL — the reference resolves, it is never news
    const ev = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        'SELECT seq, branch_name, rejected_reason FROM event_index WHERE event_id = $1;',
        [String(topic.event_id)],
      );
      return r.rows.length ? r.rows[0] : null;
    });
    assert(ev !== null, 'evidence row exists');
    assertEquals(ev.seq, null);
    assertEquals(ev.branch_name, null);
  });
});

Deno.test('missing: expiry removes the placeholder (a later delivery is a first delivery)', async () => {
  await withSetup(async ({ fake }) => {
    const orphan = await remoteMsg(fake, 'short-lived', ['$nobody'], {
      depth: 51,
    });
    await withRoomLock(ROOM, async () => {
      await storeUngroundedLocked(ROOM, orphan, fake.name);
    });
    assertEquals(
      await groundingOf(ROOM, String(orphan.event_id)),
      'placeholder',
    );
    await withDb(serverDb(), async (c) => {
      await c.query(
        'UPDATE event_index SET expires_ms = $1 WHERE event_id = $2;',
        [Date.now() - 1, String(orphan.event_id)],
      );
    });
    const swept = await sweepExpiredPlaceholders(ROOM);
    assertEquals(swept, 1);
    assertEquals(await groundingOf(ROOM, String(orphan.event_id)), 'unknown');
  });
});

Deno.test('missing: a pulled event with its own missing prev waits as a placeholder; /state_ids names the gap tip behind it', async () => {
  await withSetup(async ({ fake, answer, stateIds, eventAnswers }) => {
    const tip = await latestExtremityEventId(ROOM);
    // the chain: pushed → near → far → tip (held); the answer carries
    // only `near`, whose own prev (far) is missing
    const far = await remoteMsg(fake, 'far', [tip], { depth: 50 });
    const near = await remoteMsg(fake, 'near', [String(far.event_id)], {
      depth: 51,
    });
    answer.events = [near];
    // a real /state_ids answer carries the room's state rows (create +
    // the sender's member — spec rule 5 wants the sender joined); both
    // are held, their rows land in the pack's materialized state
    const createId = await createIdOf(ROOM);
    const currentRows = await stateAtSeq(ROOM, null);
    const rudyJoinId = currentRows === null
      ? null
      : currentRows.find((r) =>
        r.type === 'm.room.member' && r.stateKey === `@rudy:${fake.name}`
      )?.eventId ?? null;
    assert(rudyJoinId !== null, "rudy's join is in the state");
    stateIds.set(String(far.event_id), {
      pdu_ids: [createId, rudyJoinId],
      auth_chain_ids: [],
    });
    eventAnswers.set(String(far.event_id), far);
    const pushed = await remoteMsg(fake, 'pushed', [String(near.event_id)], {
      depth: 52,
    });
    const stateIdRequests: string[] = [];
    const origGet = stateIds.get.bind(stateIds);
    stateIds.get = (k: string) => {
      stateIdRequests.push(k);
      return origGet(k);
    };
    await fetchMissingPrevs(ROOM, pushed, fake.name, {
      until: Date.now() + 8000,
    });
    // near waited as a placeholder, never dropped; the /state_ids call
    // named the FAR event (the gap tip), never the held one
    assert(
      stateIdRequests.includes(String(far.event_id)),
      `state_ids for far: ${JSON.stringify(stateIdRequests)}`,
    );
    assert(
      !stateIdRequests.includes(String(near.event_id)),
      `state_ids never for the held near: ${JSON.stringify(stateIdRequests)}`,
    );
    // far packed, then the chain grounds through it (the re-check
    // driver runs after the pack's lock releases)
    await waitGrounding(String(far.event_id), 'own');
    await waitGrounding(String(near.event_id), 'own');
    await ingestEvent(ROOM, pushed, {
      remote: { origin: fake.name, position: 'after' },
    });
    assertEquals(await groundingOf(ROOM, String(pushed.event_id)), 'own');
  });
});
