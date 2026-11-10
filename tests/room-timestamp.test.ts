import { assert, assertEquals } from '@std/assert';
import { canSeeEventAt } from '#engine/client/visibility.ts';
import type { Pdu } from '#engine/pdu.ts';
import { findTimestamp } from '#engine/room/timestamp.ts';
import { searchTimestamp } from '#engine/room/timestamp-search.ts';
import { backfill, bridgeForwardAnchor } from '#engine/room/history.ts';
import { openRoom, type Room, roomSchema } from '#engine/room/index.ts';
import { ingestInTx } from '#engine/room/ingest.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { verify } from '#engine/room/verify.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { fakeFetcher, fakeKeyResolver } from '#tests/fixtures/remote.ts';
import { makeFakeRoom } from '#tests/fixtures/remote-room.ts';
import type { RoomTx } from '#engine/room/index.ts';

const options = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});
async function fixture(
  fn: (
    s: {
      store: Store;
      room: Room;
      fr: Awaited<ReturnType<typeof makeFakeRoom>>;
      deps: ReturnType<typeof dependencies>;
      reopen: () => Promise<Room>;
    },
  ) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  let store = await openStore(options(dir), {
    schemas: { room: roomSchema },
  });
  try {
    const fr = await makeFakeRoom({ roomId: '!timestamp:remote.test' });
    const room = await openRoom(store, fr.roomId, { create: true });
    const deps = dependencies(fr);
    const create = await verify(
      [...fr.events.values()][0],
      fr.version,
      deps.keys,
      { roomId: fr.roomId },
    );
    await room.tx(async (tx) => {
      const empty = await tx.materialize.newGroup(null, []);
      await tx.segments.create({ kind: 'stay', opening_group: empty });
      await ingestInTx(tx, fr.roomId, create.pdu, {
        remote: {
          origin: fr.server.name,
          self: 'test',
          oversized: false,
          ungroundedMs: 3600000,
        },
      });
    });
    await ingestRemote(
      room,
      [...fr.events.values()].slice(1),
      fr.server.name,
      deps,
    );
    await fn({
      store,
      room,
      fr,
      deps,
      reopen: async () => {
        await store.close();
        store = await openStore(options(dir), {
          schemas: { room: roomSchema },
        });
        return await openRoom(store, fr.roomId);
      },
    });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}
function dependencies(fr: Awaited<ReturnType<typeof makeFakeRoom>>) {
  return {
    keys: fakeKeyResolver(fr.server),
    fetcher: fakeFetcher({}).fetcher,
    self: 'test',
    limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
    ungroundedMs: 3600000,
  };
}
const message = (
  ts: number,
  body: string,
  prev?: string[],
  depth?: number,
) => ({
  type: 'm.room.message',
  content: { msgtype: 'm.text', body },
  origin_server_ts: ts,
  ...(prev === undefined ? {} : { prev_events: prev }),
  ...(depth === undefined ? {} : { depth }),
});

Deno.test('timestamp: causal ties cross skewed intermediate timestamps, ignore depths, and keep first-owner branch order', async () => {
  await fixture(async ({ fr, room, deps }) => {
    const root = fr.tipId;
    const parent = await fr.addEvent(message(100, 'parent', [root], 9000));
    const sibling = await fr.addEvent(message(100, 'sibling', [root], 2));
    const bridge = await fr.addEvent(
      message(50, 'bridge', [parent.event_id!], 3),
    );
    const child = await fr.addEvent(
      message(100, 'child', [bridge.event_id!], 1),
    );
    for (const event of [parent, sibling, bridge, child]) {
      await ingestRemote(room, [event], fr.server.name, deps);
    }
    const lookup = (dir: 'f' | 'b', hidden?: string) =>
      room.tx((tx) =>
        findTimestamp(
          tx,
          { ts: 100, dir },
          (id) => Promise.resolve(id !== hidden),
        )
      );
    assertEquals((await lookup('f'))?.event_id, parent.event_id);
    assertEquals((await lookup('b'))?.event_id, child.event_id);
    assertEquals(
      (await lookup('b', child.event_id))?.event_id,
      sibling.event_id,
    );
    assertEquals(
      await room.tx((tx) =>
        findTimestamp(tx, { ts: 101, dir: 'f' }, () => Promise.resolve(true))
      ),
      null,
    );
    // Grounding, standing and position are independent eligibility dimensions.
    await room.tx(async (tx) => {
      await tx.events.setStatus(child.event_id!, {
        standing: 'soft_failed',
        grounding: 'grounded',
        origin: fr.server.name,
        received_ts: 0,
      });
      await tx.events.setStatus(sibling.event_id!, {
        standing: 'accepted',
        grounding: 'evidence',
        origin: fr.server.name,
        received_ts: 0,
      });
    });
    assertEquals((await lookup('b'))?.event_id, parent.event_id);
    const hidden = await room.tx((tx) =>
      findTimestamp(
        tx,
        { ts: 50, dir: 'f' },
        (id) => Promise.resolve(id !== bridge.event_id),
      )
    );
    assertEquals(hidden?.event_id, parent.event_id);
  });
});

Deno.test('timestamp: verified disjoint anchor owns its gap, backfills earlier history and survives reopen without news', async () => {
  await fixture(async ({ fr, room, deps, reopen }) => {
    const a = await fr.addEvent(message(100, 'a'));
    const b = await fr.addEvent(message(110, 'b'));
    const anchor = await fr.addEvent(message(120, 'anchor'));
    const remote = fakeFetcher({
      event: fr.events,
      stateIds: new Map(
        [...fr.events.keys()].map((id) => [id, fr.stateIdsAt(id)!]),
      ),
      backfill: (from, limit) => fr.backfillPdus(from, limit),
    });
    let queries = 0;
    deps.fetcher = {
      ...remote.fetcher,
      timestampToEvent: () => {
        queries++;
        return Promise.resolve({
          event_id: anchor.event_id!,
          origin_server_ts: 120,
        });
      },
    };
    const before = await room.tx(async (tx) => ({
      stay: await tx.segments.latestStay(),
      segments: await tx.segments.list(),
      frontier: await tx.extremities.frontier(
        (await tx.segments.latestStay())!.id,
      ),
      changes: await tx.changes.after(0, 10000),
    }));
    const hit = await searchTimestamp(
      room,
      { ts: 115, dir: 'f' },
      (tx, id) => canSeeEventAt(fr.creator, tx, id),
      deps,
    );
    assertEquals(hit, { event_id: anchor.event_id, origin_server_ts: 120 });
    assertEquals(queries, 1);
    const pos = (await room.tx((tx) =>
      tx.segments.positionOf(anchor.event_id!)
    ))!;
    assert(pos !== null);
    assertEquals(
      (await room.tx((tx) => tx.segments.get(pos.segment)))?.kind,
      'anchor',
    );
    assertEquals(
      await room.tx((tx) => tx.segments.historyOf(before.stay!.id)),
      null,
    );
    assertEquals(
      (await room.tx((tx) => tx.state.eventStateBefore(anchor.event_id!)))
        ?.provenance,
      'imported',
    );
    const gap = await room.tx((tx) => tx.segments.step(pos, 'b'));
    assert(gap.kind === 'frontier');
    assertEquals(gap.prevs, [b.event_id]);
    const filled = await backfill(room, {
      from: gap.prevs,
      limit: 3,
      via: fr.server.name,
      stay: before.stay!.id,
      segment: pos.segment,
    }, deps);
    assertEquals(filled.segment, pos.segment);
    assert(filled.positioned.includes(a.event_id!));
    assertEquals(
      await room.tx((tx) => tx.segments.positionOf(anchor.event_id!)),
      pos,
    );
    const previous = await room.tx((tx) => tx.segments.step(pos, 'b'));
    assert(previous.kind === 'event');
    assertEquals(previous.event, b.event_id);
    assertEquals(
      (await room.tx((tx) => tx.segments.step(pos, 'f'))).kind,
      'gap',
    );
    assertEquals(await room.tx((tx) => tx.segments.latestStay()), before.stay);
    assertEquals(
      await room.tx((tx) => tx.extremities.frontier(before.stay!.id)),
      before.frontier,
    );
    const changes = await room.tx((tx) =>
      tx.changes.after(before.changes.at(-1)!.pos, 10000)
    );
    assert(changes.every((c) => c.kind === 'history'));
    const reopened = await reopen();
    assertEquals(
      await reopened.tx((tx) => tx.segments.positionOf(anchor.event_id!)),
      pos,
    );
    assertEquals(
      (await reopened.tx((tx) => tx.state.eventStateBefore(anchor.event_id!)))
        ?.provenance,
      'imported',
    );
  });
});

Deno.test('timestamp: hidden time buckets do not terminate a real viewer visibility search', async () => {
  await fixture(async ({ fr, room, deps }) => {
    const privateHistory = await fr.addEvent({
      type: 'm.room.history_visibility',
      state_key: '',
      content: { history_visibility: 'joined' },
      origin_server_ts: 90,
    });
    const hidden = await fr.addEvent(message(100, 'hidden'));
    const publicHistory = await fr.addEvent({
      type: 'm.room.history_visibility',
      state_key: '',
      content: { history_visibility: 'world_readable' },
      origin_server_ts: 200,
    });
    for (const event of [privateHistory, hidden, publicHistory]) {
      await ingestRemote(room, [event], fr.server.name, deps);
    }
    const viewer = '@outsider:remote.test';
    assertEquals(
      await room.tx((tx) =>
        findTimestamp(
          tx,
          { ts: 95, dir: 'f' },
          (id) => canSeeEventAt(viewer, tx, id),
        )
      ),
      { event_id: publicHistory.event_id, origin_server_ts: 200 },
    );
    assertEquals(
      await room.tx((tx) =>
        findTimestamp(
          tx,
          { ts: 150, dir: 'b' },
          (id) => canSeeEventAt(viewer, tx, id),
        )
      ),
      null,
    );
  });
});

Deno.test('timestamp: untrusted claims, wrong side, signatures and unavailable state never become usable hits', async () => {
  await fixture(async ({ fr, room, deps }) => {
    await fr.addEvent(message(80, 'missing predecessor'));
    const anchor = await fr.addEvent(message(100, 'anchor'));
    const remote = fakeFetcher({ event: fr.events });
    for (
      const claim of [
        { event_id: '$not-the-pdu', origin_server_ts: 100 },
        { event_id: anchor.event_id!, origin_server_ts: 999 },
        { event_id: anchor.event_id!, origin_server_ts: 100 },
      ]
    ) {
      deps.fetcher = {
        ...remote.fetcher,
        event: () => Promise.resolve(anchor),
        timestampToEvent: () => Promise.resolve(claim),
      };
      assertEquals(
        await searchTimestamp(
          room,
          { ts: 90, dir: 'f' },
          (_tx, _id) => Promise.resolve(true),
          deps,
        ),
        null,
      );
    }
    assertEquals(
      await room.tx((tx) => tx.segments.positionOf(anchor.event_id!)),
      null,
    );
    assertEquals(
      (await room.tx((tx) => tx.segments.list())).filter((s) =>
        s.kind === 'anchor'
      ),
      [],
    );
    deps.fetcher = {
      ...remote.fetcher,
      timestampToEvent: () =>
        Promise.resolve({ event_id: anchor.event_id!, origin_server_ts: 100 }),
    };
    assertEquals(
      await searchTimestamp(
        room,
        { ts: 110, dir: 'f' },
        (_tx, _id) => Promise.resolve(true),
        deps,
      ),
      null,
    );
    const forged = { ...anchor, signatures: {} } as Pdu;
    deps.fetcher = { ...deps.fetcher, event: () => Promise.resolve(forged) };
    assertEquals(
      await searchTimestamp(
        room,
        { ts: 90, dir: 'f' },
        (_tx, _id) => Promise.resolve(true),
        deps,
      ),
      null,
    );
  });
});

for (const mode of ['anchor', 'page'] as const) {
  Deno.test(
    'history admission: ACL change during ' + mode +
      ' fetch preserves the open-gap result',
    async () => {
      await fixture(async ({ fr, room, deps }) => {
        const root = fr.tipId;
        await fr.addEvent(message(80, 'missing parent'));
        const anchor = await fr.addEvent(message(100, 'remote anchor'));
        const acl = await fr.addEvent({
          type: 'm.room.server_acl',
          state_key: '',
          prev_events: [root],
          content: { allow: ['*'], deny: [fr.server.name] },
        });
        const remote = fakeFetcher({
          event: fr.events,
          stateIds: new Map([[
            anchor.event_id!,
            fr.stateIdsAt(anchor.event_id!)!,
          ]]),
          backfill: [anchor],
          onStateIds: async () => {
            const admitted = await ingestRemote(
              room,
              [acl],
              fr.server.name,
              deps,
            );
            assertEquals(admitted[0].outcome, 'accepted');
          },
        });
        const result = await backfill(room, {
          from: [anchor.event_id!],
          limit: 1,
          via: fr.server.name,
          ...(mode === 'anchor' ? { anchor } : {}),
        }, { ...deps, fetcher: remote.fetcher });
        assertEquals(result, {
          outcome: 'open',
          segment: null,
          positioned: [],
        });
        assertEquals(
          await room.tx((tx) => tx.segments.positionOf(anchor.event_id!)),
          null,
        );
        assertEquals(
          (await room.tx((tx) => tx.segments.list())).filter((s) =>
            s.kind !== 'stay'
          ),
          [],
        );
      });
    },
  );
}

Deno.test('history admission: an already denied peer is never fetched', async () => {
  await fixture(async ({ fr, room, deps }) => {
    const acl = await fr.addEvent({
      type: 'm.room.server_acl',
      state_key: '',
      content: { allow: ['*'], deny: [fr.server.name] },
    });
    await ingestRemote(room, [acl], fr.server.name, deps);
    const remote = fakeFetcher({ backfill: [] });
    assertEquals(
      await backfill(room, {
        from: ['$missing'],
        limit: 1,
        via: fr.server.name,
      }, { ...deps, fetcher: remote.fetcher }),
      { outcome: 'open', segment: null, positioned: [] },
    );
    assertEquals(remote.calls.backfill, []);
  });
});

Deno.test('timestamp: a disjoint anchor after leave cannot inherit an earlier publication join', async () => {
  await fixture(async ({ fr, room, deps }) => {
    const viewer = '@former:' + fr.server.name;
    const joined = await fr.addEvent({
      type: 'm.room.member',
      sender: viewer,
      state_key: viewer,
      content: { membership: 'join' },
      origin_server_ts: 10,
    });
    const left = await fr.addEvent({
      type: 'm.room.member',
      sender: viewer,
      state_key: viewer,
      content: { membership: 'leave' },
      origin_server_ts: 20,
    });
    await ingestRemote(room, [joined, left], fr.server.name, deps);
    await fr.addEvent(message(25, 'unheld bridge'));
    const anchor = await fr.addEvent(message(30, 'after leave'));
    deps.fetcher = fakeFetcher({
      event: fr.events,
      stateIds: new Map([[anchor.event_id!, fr.stateIdsAt(anchor.event_id!)!]]),
    }).fetcher;
    await backfill(room, {
      from: [anchor.event_id!],
      limit: 1,
      via: fr.server.name,
      anchor,
    }, deps);
    assertEquals(
      await room.tx((tx) => canSeeEventAt(viewer, tx, anchor.event_id!)),
      false,
    );
    assertEquals(
      await room.tx((tx) =>
        findTimestamp(
          tx,
          { ts: 30, dir: 'f' },
          (id) => canSeeEventAt(viewer, tx, id),
        )
      ),
      null,
    );
    const rejoined = await fr.addEvent({
      type: 'm.room.member',
      sender: viewer,
      state_key: viewer,
      content: { membership: 'join' },
      origin_server_ts: 40,
    });
    await ingestRemote(room, [rejoined], fr.server.name, deps);
    assertEquals(
      await room.tx((tx) => canSeeEventAt(viewer, tx, anchor.event_id!)),
      true,
    );
  });
});

Deno.test('timestamp: nearby causal ties do not read the old room prefix', async () => {
  let reads = 0;
  const parents = (id: string) => {
    reads++;
    assert(reads < 40, 'nearby tie must not walk to room genesis');
    const n = Number(id.slice(1));
    return n > 0 ? ['$' + (n - 1)] : [];
  };
  const tx = {
    events: {
      timestampBucket: () =>
        Promise.resolve([
          { id: '$100001', ts: 100, segment: 1, offset: 0 },
          { id: '$100002', ts: 100, segment: 1, offset: 1 },
        ]),
      ancestors: () => Promise.resolve({ ids: [], truncated: true }),
      prevsOf: (id: string) => Promise.resolve(parents(id)),
      childrenOf: (id: string) => {
        reads++;
        const n = Number(id.slice(1));
        return Promise.resolve(n < 100002 ? ['$' + (n + 1)] : []);
      },
    },
    segments: {
      positionOf: (id: string) =>
        Promise.resolve({ segment: 1, offset: Number(id.slice(1)) }),
    },
  } as unknown as RoomTx;
  for (const dir of ['f', 'b'] as const) {
    assertEquals(
      await findTimestamp(tx, { ts: 100, dir }, () => Promise.resolve(true)),
      { event_id: dir === 'f' ? '$100001' : '$100002', origin_server_ts: 100 },
    );
  }
});

Deno.test('timestamp: causal ties survive child-first anchor acquisition without renumbering', async () => {
  await fixture(async ({ fr, room, deps }) => {
    await fr.addEvent(message(50, 'unheld prefix'));
    const parent = await fr.addEvent(message(100, 'parent'));
    const child = await fr.addEvent(message(100, 'child', undefined, 1));
    deps.fetcher = fakeFetcher({
      event: fr.events,
      stateIds: new Map(
        [...fr.events.keys()].map((id) => [id, fr.stateIdsAt(id)!]),
      ),
    }).fetcher;
    for (const anchor of [child, parent]) {
      await backfill(room, {
        from: [anchor.event_id!],
        anchor,
        limit: 1,
        via: fr.server.name,
      }, deps);
    }
    const pos = await room.tx((tx) => tx.segments.positionOf(child.event_id!));
    const lookup = (dir: 'f' | 'b') =>
      room.tx((tx) =>
        findTimestamp(
          tx,
          { ts: 100, dir },
          (id) => canSeeEventAt(fr.creator, tx, id),
        )
      );
    assertEquals((await lookup('f'))?.event_id, parent.event_id);
    assertEquals((await lookup('b'))?.event_id, child.event_id);
    assertEquals(
      await room.tx((tx) => tx.segments.positionOf(child.event_id!)),
      pos,
    );
  });
});

Deno.test('timestamp: bounded forward bridging advances across independently owned anchors and survives reopen', async () => {
  await fixture(async ({ fr, room, deps, reopen }) => {
    const a = await fr.addEvent(message(100, 'a'));
    const b = await fr.addEvent(message(110, 'b'));
    const c = await fr.addEvent(message(120, 'c'));
    deps.fetcher = fakeFetcher({
      event: fr.events,
      stateIds: new Map(
        [...fr.events.keys()].map((id) => [id, fr.stateIdsAt(id)!]),
      ),
      backfill: (from, limit) => fr.backfillPdus(from, limit),
    }).fetcher;
    for (const anchor of [a, c]) {
      await backfill(room, {
        from: [anchor.event_id!],
        anchor,
        limit: 1,
        via: fr.server.name,
      }, deps);
    }
    const pos = (await room.tx((tx) => tx.segments.positionOf(a.event_id!)))!;
    assertEquals(
      (await room.tx((tx) => tx.segments.step(pos, 'f'))).kind,
      'gap',
    );
    assertEquals(
      await bridgeForwardAnchor(room, pos, [fr.server.name], 1, deps),
      true,
    );
    const next = await room.tx((tx) => tx.segments.step(pos, 'f'));
    assert(next.kind === 'event');
    assertEquals(next.event, b.event_id);
    const last = await room.tx((tx) => tx.segments.step(next.cursor, 'f'));
    assert(last.kind === 'event');
    assertEquals(last.event, c.event_id);
    const reopened = await reopen();
    assertEquals(await reopened.tx((tx) => tx.segments.step(pos, 'f')), next);
    assertEquals(
      await reopened.tx((tx) => tx.segments.positionOf(a.event_id!)),
      pos,
    );
  });
});
