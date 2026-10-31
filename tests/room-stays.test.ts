// tests/room-stays.test.ts — stays and the read contracts (3c-2):
// join → leave closes the live stay (extremities archived) → rejoin
// opens a NEW stay with prev = the old one; the old stay's positions
// and state stay readable; state just before the second stay's first
// event IS its opening group (G5); the walk crosses stay → history →
// previous stay backward and continues into the next stay forward
// (G7); a read of an event always uses that event's own state refs,
// never the current state (G6).
import { assert, assertEquals } from '@std/assert';
import type { Pdu } from '#engine/pdu.ts';
import { backfill } from '#engine/room/history.ts';
import {
  formatCursor,
  openRoom,
  parseCursor,
  type Room,
  roomSchema,
  type WalkCursor,
} from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { joinRemote } from '#engine/room/join.ts';
import { leave } from '#engine/room/membership.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  remoteEvent,
} from './fixtures/remote.ts';
import { fakeMessage, makeFakeRoom } from './fixtures/remote-room.ts';
import { testRemoteServer, testSigner } from './fixtures/signer.ts';

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
    schemas: { room: roomSchema },
  });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

const ANNA = '@anna:test';

async function joinDepsFor(fr: Awaited<ReturnType<typeof makeFakeRoom>>) {
  const { fetcher } = fakeFetcher({
    makeJoin: (userId) => fr.makeJoinAnswer(userId),
    sendJoin: (event) => fr.acceptSendJoin(event),
  });
  return {
    keys: fakeKeyResolver(fr.server, await testRemoteServer()),
    fetcher,
    self: 'test',
  };
}

// The whole walk in one direction from a cursor, collecting events.
async function walkAll(
  room: Room,
  cursor: WalkCursor,
  dir: 'f' | 'b',
): Promise<{ events: string[]; end: 'end' | { prevs: string[] } }> {
  const events: string[] = [];
  let at = cursor;
  for (;;) {
    const step = await room.tx((tx) => tx.segments.step(at, dir));
    if (step.kind === 'end') return { events, end: 'end' };
    if (step.kind === 'frontier') {
      return { events, end: { prevs: step.prevs } };
    }
    events.push(step.event);
    at = step.cursor;
  }
}

Deno.test('stays: join → leave closes → rejoin opens a new stay; the old stay stays readable; the walk crosses both', async () => {
  await withStore(async (store) => {
    const fr = await makeFakeRoom({ roomId: '!s1:remote.test' });
    await fakeMessage(fr, 'before we arrive');
    const signer = await testSigner();
    const deps = await joinDepsFor(fr);

    // the first join opens the first stay
    const join1 = await joinRemote(store, {
      roomId: fr.roomId,
      user: ANNA,
      via: [fr.server.name],
      signer,
      deps,
    });
    const room = await openRoom(store, fr.roomId);
    // traffic on the first stay
    const msg = await sendLocal(room, {
      type: 'm.room.message',
      sender: ANNA,
      content: { msgtype: 'm.text', body: 'stay1' },
      origin_server_ts: 100,
    }, signer);
    assertEquals(msg.standing, 'accepted');
    const ids = await room.tx(async (tx) => {
      const stay = (await tx.segments.openStay())!;
      return { stayId: stay.id, opening: stay.opening_group };
    });

    // the sole local member leaves — the stay closes (I15), the
    // extremities are archived with it (R9)
    await leave(room, ANNA, signer);
    await room.tx(async (tx) => {
      assertEquals(await tx.segments.openStay(), null);
      const closed = await tx.segments.get(ids.stayId);
      assertEquals(closed?.status, 'closed');
      // the leave is the stay's last position and its only extremity
      const frontier = await tx.extremities.frontier(ids.stayId);
      assertEquals(frontier.length, 1);
      const leaveEvent = await tx.events.get(frontier[0]);
      assertEquals(leaveEvent?.type, 'm.room.member');
    });
    const stay1State = await room.tx((tx) =>
      tx.state.publishedAt(ids.stayId, Number.MAX_SAFE_INTEGER)
    );

    // the gap while we are away
    await fakeMessage(fr, 'gap1');
    await fakeMessage(fr, 'gap2');

    // the re-join: a NEW stay, prev = the old one
    const join2 = await joinRemote(store, {
      roomId: fr.roomId,
      user: ANNA,
      via: [fr.server.name],
      signer,
      deps,
    });
    assert(join2.eventId !== join1.eventId);
    const s2 = await room.tx(async (tx) => {
      const stay = (await tx.segments.openStay())!;
      assert(stay.id !== ids.stayId);
      assertEquals(stay.prev, ids.stayId);
      assertEquals(stay.opened_by, join2.eventId);
      return { stayId: stay.id, opening: stay.opening_group };
    });
    // the old stay is intact: same published state, same extremity
    await room.tx(async (tx) => {
      assertEquals(
        await tx.state.publishedAt(ids.stayId, Number.MAX_SAFE_INTEGER),
        stay1State,
      );
      assertEquals((await tx.extremities.frontier(ids.stayId)).length, 1);
      const oldStay = await tx.segments.get(ids.stayId);
      assertEquals(oldStay?.status, 'closed');
    });

    // G5: state just before the second stay's first event IS its
    // opening group (G5's imported-boundary semantics)
    await room.tx(async (tx) => {
      const joinPos = await tx.changes.posOf(join2.eventId);
      assert(joinPos !== null);
      assertEquals(
        await tx.state.publishedAt(s2.stayId, joinPos - 1),
        s2.opening,
      );
      // and AT the join: the publication it recorded
      const after = await tx.state.eventStateAfter(join2.eventId);
      assertEquals(
        await tx.state.publishedAt(s2.stayId, joinPos),
        after?.group,
      );
    });

    // backfill the gap into the new stay's history segment
    const join2Pdu = await room.tx(async (tx) =>
      JSON.parse((await tx.events.get(join2.eventId))!.pdu) as Pdu
    );
    const fetchGap = fakeFetcher({
      backfill: (from, limit) => fr.backfillPdus(from, limit),
    });
    const filled = await backfill(
      room,
      { from: join2Pdu.prev_events ?? [], limit: 10, via: fr.server.name },
      {
        keys: fakeKeyResolver(fr.server, await testRemoteServer()),
        fetcher: fetchGap.fetcher,
      },
    );
    assertEquals(filled.outcome, 'complete'); // the first join is held
    assertEquals(filled.positioned.length, 2); // gap1, gap2 — the cut

    // the backward walk so far: the new stay → its history → the old
    // stay — and the FRONTIER of the older gap (the first join's prevs)
    const start = await room.tx((tx) => tx.segments.walkStart());
    assert(start !== null && start.segment === s2.stayId);
    const backward1 = await walkAll(room, start, 'b');
    const join1Pdu = await room.tx(async (tx) =>
      JSON.parse((await tx.events.get(join1.eventId))!.pdu) as Pdu
    );
    const leaveId = await room.tx((tx) =>
      tx.extremities.frontier(ids.stayId).then((f) => f[0])
    );
    assertEquals(
      backward1.events,
      [
        join2.eventId,
        ...filled.positioned.slice().reverse(),
        leaveId,
        msg.eventId,
        join1.eventId,
      ],
    );
    assertEquals(backward1.end, { prevs: join1Pdu.prev_events ?? [] });

    // the older gap lands in the OLD stay's history segment (the stay
    // hint names the frontier's owner)
    const filledOld = await backfill(
      room,
      {
        from: join1Pdu.prev_events ?? [],
        limit: 10,
        via: fr.server.name,
        stay: ids.stayId,
      },
      {
        keys: fakeKeyResolver(fr.server, await testRemoteServer()),
        fetcher: fetchGap.fetcher,
      },
    );
    assertEquals(filledOld.outcome, 'complete'); // the create is in it
    assertEquals(filledOld.positioned.length, 6);
    assert(filledOld.segment !== filled.segment);

    // the full backward walk: 3, 2, 1, 0 — the old re-join story
    const backward = await walkAll(room, start, 'b');
    assertEquals(
      backward.events,
      [
        join2.eventId,
        ...filled.positioned.slice().reverse(), // gap2, gap1
        leaveId,
        msg.eventId,
        join1.eventId,
        ...filledOld.positioned.slice().reverse(), // m0, hv, jr, pl, zoe, create
      ],
    );
    assertEquals(backward.end, 'end');

    // the forward walk from the create crosses every boundary (G7):
    // old history → old stay → new history → new stay
    const bottom: WalkCursor = {
      segment: filledOld.segment!,
      offset: await room.tx(async (tx) => {
        const createPos = await tx.segments.positionOf(
          filledOld.positioned[0],
        );
        return createPos!.offset - 1;
      }),
    };
    const forward = await walkAll(room, bottom, 'f');
    assertEquals(forward.end, 'end');
    assertEquals(
      forward.events,
      [
        ...filledOld.positioned, // create, zoe, pl, jr, hv, m0
        join1.eventId,
        msg.eventId,
        leaveId,
        ...filled.positioned, // gap1, gap2
        join2.eventId,
      ],
    );

    // cursor tokens round-trip, negative offsets included
    for (
      const cursor of [{ segment: ids.stayId, offset: 2 }, {
        segment: filled.segment!,
        offset: -2,
      }]
    ) {
      assertEquals(parseCursor(formatCursor(cursor)), cursor);
    }
    assertEquals(parseCursor('not-a-token'), null);
  });
});

Deno.test('stays: a read of an event uses its own state refs, never the current state (G6)', async () => {
  await withStore(async (store) => {
    const fr = await makeFakeRoom({ roomId: '!s2:remote.test' });
    // a topic on the wire BEFORE we arrive; the join's snapshot carries
    // it as evidence, the backfill grounds it in history
    await fr.addEvent({
      type: 'm.room.topic',
      state_key: '',
      content: { topic: 'first wire topic' },
    });
    await fakeMessage(fr, 'm1');
    const signer = await testSigner();
    const deps = await joinDepsFor(fr);
    const join1 = await joinRemote(store, {
      roomId: fr.roomId,
      user: ANNA,
      via: [fr.server.name],
      signer,
      deps,
    });
    const room = await openRoom(store, fr.roomId);
    const topicEvent = [...fr.events.values()].find((p) =>
      p.type === 'm.room.topic'
    )!;
    // the join is behind the topic: backfill grounds the topic event
    const fetchGap = fakeFetcher({
      backfill: (from, limit) => fr.backfillPdus(from, limit),
    });
    const joinPdu = await room.tx(async (tx) =>
      JSON.parse((await tx.events.get(join1.eventId))!.pdu) as Pdu
    );
    const filled = await backfill(
      room,
      { from: joinPdu.prev_events ?? [], limit: 10, via: fr.server.name },
      {
        keys: fakeKeyResolver(fr.server, await testRemoteServer()),
        fetcher: fetchGap.fetcher,
      },
    );
    assertEquals(filled.outcome, 'complete');

    // a NEWER topic moves the live current state (zoe authors it — she
    // holds the power in this room; it arrives as a remote event)
    const zoeJoinId = [...fr.events.values()][1].event_id!;
    const newer = await remoteEvent(fr.roomId, fr.server, '11', {
      type: 'm.room.topic',
      sender: fr.creator,
      state_key: '',
      content: { topic: 'the wire moved on' },
      prev_events: [join1.eventId],
      auth_events: [fr.createId, fr.powerLevelsId, zoeJoinId],
      origin_server_ts: 500,
    });
    const newerOutcomes = await ingestRemote(room, [newer], fr.server.name, {
      keys: fakeKeyResolver(fr.server),
      fetcher: fakeFetcher({}).fetcher,
      self: 'test',
      limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
      ungroundedMs: 3_600_000,
    });
    assertEquals(newerOutcomes[0].outcome, 'accepted');
    const newerId = String(newer.event_id);

    await room.tx(async (tx) => {
      const stay = (await tx.segments.openStay())!;
      const current = await tx.state.current(stay.id);
      assertEquals(
        await tx.state.groupKey(current!, 'm.room.topic', ''),
        newerId,
      );
      // the history event's read uses ITS OWN refs: after(it) carries
      // the wire topic, never the current one
      const read = await tx.state.eventReadState(String(topicEvent.event_id));
      assert(read !== null);
      assertEquals(
        await tx.state.groupKey(read.after.group, 'm.room.topic', ''),
        String(topicEvent.event_id),
      );
      // and it differs from the current state — no fallback
      const currentTopic = await tx.state.groupKey(
        current!,
        'm.room.topic',
        '',
      );
      assert(
        currentTopic !==
          (await tx.state.groupKey(read.after.group, 'm.room.topic', '')),
      );
    });
  });
});
