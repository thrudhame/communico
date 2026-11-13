// tests/room-history.test.ts — backfill into history segments (3c-2):
// a linear page lands oldest-first with first-owner positions, complete
// at the create/overlap; held evidence promoted; a forked page where
// depth order ≠ topological order gets per-event DAG state (G4); a
// page-edge state event takes the imported boundary (G1/G3), and a
// failing state_ids lands evidence; history is never news (no
// publication/delivery/membership change entries).
import { assert, assertEquals, assertRejects } from '@std/assert';
import type { Pdu } from '#engine/pdu.ts';
import type { RemoteDeps } from '#engine/room/deps.ts';
import { backfill } from '#engine/room/history.ts';
import { openRoom, type Room, roomSchema } from '#engine/room/index.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import { ingestInTx } from '#engine/room/ingest.ts';
import { verify } from '#engine/room/verify.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  remoteEvent,
} from './fixtures/remote.ts';
import {
  fakeMessage,
  type FakeRoom,
  makeFakeRoom,
} from './fixtures/remote-room.ts';

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

type Setup = Awaited<ReturnType<typeof setup>>;

// The local room file holding the fake room's first events (ingested
// live as remote PDUs) plus the latest event landed through the
// missing-prev chase: the gap tip grounds on the imported boundary and
// the fetched state events are held as EVIDENCE.
async function setup(
  store: Store,
  opts: {
    roomId: string;
    build: (fr: FakeRoom) => Promise<{ live: Pdu[]; latest: Pdu }>;
  },
) {
  const fr = await makeFakeRoom({ roomId: opts.roomId });
  const { live, latest } = await opts.build(fr);
  const room = await openRoom(store, fr.roomId, { create: true });
  const keys = fakeKeyResolver(fr.server);
  // the remote create bootstraps the room file (the stay's version is
  // read from it) — verified, then through the locked pipeline
  const create = await verify(live[0], fr.version, keys, {
    roomId: fr.roomId,
  });
  await withRoomLock(fr.roomId, () =>
    room.tx(async (tx) => {
      const empty = await tx.materialize.newGroup(null, []);
      await tx.segments.create({ kind: 'stay', opening_group: empty });
      const created = await ingestInTx(tx, fr.roomId, create.pdu, {
        remote: {
          origin: fr.server.name,
          self: 'test',
          oversized: create.oversized,
          ungroundedMs: 3_600_000,
        },
      });
      assertEquals(created.standing, 'accepted');
    }));
  const deps: RemoteDeps = {
    keys,
    fetcher: fakeFetcher({}).fetcher,
    self: 'test',
    limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
    ungroundedMs: 3_600_000,
  };
  const rest = live.slice(1);
  if (rest.length > 0) {
    const first = await ingestRemote(room, rest, fr.server.name, deps);
    for (const outcome of first) assertEquals(outcome.outcome, 'accepted');
  }
  // A pulled latest event permits recovery behind its missing parent.
  const gapTip = String(latest.prev_events![0]);
  const chase = fakeFetcher({
    missingEvents: [],
    stateIds: new Map([[gapTip, fr.stateIdsAt(gapTip)!]]),
    event: new Map(
      [...fr.events.entries()].map(([id, pdu]) => [id, pdu] as [string, Pdu]),
    ),
  });
  deps.fetcher = chase.fetcher;
  const second = await ingestRemote(
    room,
    [latest],
    fr.server.name,
    deps,
    'pulled',
  );
  assertEquals(second[0].outcome, 'accepted');
  return { fr, room, deps, gapTip, live, latest };
}

async function offsetsOf(
  room: Room,
  ids: string[],
): Promise<Map<string, { segment: number; offset: number }>> {
  return await room.tx(async (tx) => {
    const out = new Map<string, { segment: number; offset: number }>();
    for (const id of ids) {
      const pos = await tx.segments.positionOf(id);
      if (pos !== null) out.set(id, pos);
    }
    return out;
  });
}

Deno.test('backfill: oversized boundaries retain evidence without blocking later complete boundaries', async () => {
  await withStore(async (store) => {
    const s = await setup(store, {
      roomId: '!history-boundary-cap:remote.test',
      build: async (fr) => {
        const live = [...fr.events.values()];
        await fakeMessage(fr, 'gap');
        return { live, latest: await fakeMessage(fr, 'latest') };
      },
    });
    const make = (suffix: string) =>
      remoteEvent(s.room.id, s.fr.server, s.fr.version, {
        type: 'm.room.message',
        sender: s.latest.sender,
        content: { body: suffix },
        prev_events: ['$missing-' + suffix],
        auth_events: s.latest.auth_events,
        depth: 100,
      });
    const large = await make('large'), small = await make('small');
    const state = s.fr.stateIdsAt(s.latest.event_id!)!;
    const recording = fakeFetcher({
      backfill: [large, small],
      stateIds: new Map([
        [large.event_id!, {
          pduIds: state.pduIds,
          authChainIds: [
            ...state.authChainIds,
            ...Array.from({ length: 140 }, (_, i) => '$unknown' + i),
          ],
        }],
        [small.event_id!, {
          pduIds: state.pduIds,
          authChainIds: Array.from({ length: 12000 }, () => state.authChainIds)
            .flat(),
        }],
      ]),
    });
    const result = await backfill(s.room, {
      from: [s.gapTip],
      limit: 10,
      via: s.fr.server.name,
    }, { keys: s.deps.keys, fetcher: recording.fetcher });
    assertEquals(
      (await s.room.tx((tx) => tx.events.getStatus(large.event_id!)))
        ?.grounding,
      'evidence',
    );
    assertEquals(
      (await s.room.tx((tx) => tx.events.getStatus(small.event_id!)))
        ?.grounding,
      'grounded',
    );
    assert(result.positioned.includes(small.event_id!));
    assertEquals(
      recording.calls.event.length,
      0,
      'unfinishable boundaries do not spend the remaining request allowance',
    );
  });
});

Deno.test('backfill: one operation bounds requests across all independent boundaries', async () => {
  await withStore(async (store) => {
    const s = await setup(store, {
      roomId: '!history-budget:remote.test',
      build: async (fr) => {
        const live = [...fr.events.values()];
        await fakeMessage(fr, 'gap');
        const latest = await fakeMessage(fr, 'latest');
        return { live, latest };
      },
    });
    const page: Pdu[] = [];
    for (let i = 0; i < 140; i++) {
      page.push(
        await remoteEvent(s.room.id, s.fr.server, s.fr.version, {
          type: 'm.room.message',
          sender: s.latest.sender,
          content: { body: 'boundary ' + i },
          prev_events: ['$missing-' + i],
          auth_events: s.latest.auth_events,
          depth: 100,
        }),
      );
    }
    const recording = fakeFetcher({ backfill: page });
    await backfill(s.room, {
      from: [s.gapTip],
      limit: 200,
      via: s.fr.server.name,
    }, {
      keys: s.deps.keys,
      fetcher: recording.fetcher,
    });
    assert(
      recording.calls.stateIds.length <= 127,
      'the page request and all boundary reads share a 128-request budget: ' +
        recording.calls.stateIds.length,
    );
  });
});

Deno.test('backfill: cancellation settles a stalled injected fetcher; storage faults still escape', async () => {
  await withStore(async (store) => {
    const s = await setup(store, {
      roomId: '!history-cancel:remote.test',
      build: async (fr) => {
        const live = [...fr.events.values()];
        await fakeMessage(fr, 'gap');
        return { live, latest: await fakeMessage(fr, 'latest') };
      },
    });
    const abort = new AbortController();
    const recording = fakeFetcher({
      onBackfill: () => {
        queueMicrotask(() => abort.abort());
        return new Promise(() => {});
      },
    });
    const args = { from: [s.gapTip], limit: 10, via: s.fr.server.name };
    const out = await backfill(s.room, args, {
      keys: s.deps.keys,
      fetcher: recording.fetcher,
      signal: abort.signal,
    });
    assertEquals(out, { outcome: 'open', segment: null, positioned: [] });
    assertEquals(recording.calls.backfill.length, 1);
    const original = s.room.tx.bind(s.room);
    const duringWrite = new AbortController();
    const cancelled = await fakeMessage(s.fr, 'cancelled-history');
    const before = await s.room.tx((tx) => tx.changes.head());
    s.room.tx = (body) =>
      original(async (tx) => {
        const insert = tx.events.insert;
        tx.events.insert = async (id, pdu) => {
          const result = await insert(id, pdu);
          if (id === cancelled.event_id) duringWrite.abort();
          return result;
        };
        return await body(tx);
      });
    try {
      const rolledBack = await backfill(s.room, args, {
        keys: s.deps.keys,
        fetcher: fakeFetcher({ backfill: [cancelled] }).fetcher,
        signal: duringWrite.signal,
      });
      assertEquals(rolledBack, {
        outcome: 'open',
        segment: null,
        positioned: [],
      });
    } finally {
      s.room.tx = original;
    }
    assertEquals(await s.room.tx((tx) => tx.changes.head()), before);
    assertEquals(
      await s.room.tx((tx) => tx.events.get(cancelled.event_id!)),
      null,
    );
    let injected = false;
    s.room.tx = (body) =>
      original(async (tx) => {
        const insert = tx.events.insert;
        tx.events.insert = async (id, pdu) => {
          await insert(id, pdu);
          if (id === cancelled.event_id) {
            injected = true;
            throw new Error('storage-fault-inside-write');
          }
        };
        return await body(tx);
      });
    try {
      await assertRejects(
        () =>
          backfill(s.room, args, {
            ...s.deps,
            fetcher: fakeFetcher({ backfill: [cancelled] }).fetcher,
          }),
        Error,
        'storage-fault-inside-write',
      );
    } finally {
      s.room.tx = original;
    }
    assertEquals(injected, true);
    assertEquals(await s.room.tx((tx) => tx.changes.head()), before);
    assertEquals(
      await s.room.tx((tx) => tx.events.get(cancelled.event_id!)),
      null,
    );
  });
});

Deno.test('backfill: a linear page lands oldest-first; evidence promoted first-owner; complete at the create', async () => {
  await withStore(async (store) => {
    const s = await setup(store, {
      roomId: '!h1:remote.test',
      build: async (fr) => {
        await fakeMessage(fr, 'a1');
        await fakeMessage(fr, 'a2');
        await fakeMessage(fr, 'a3');
        // b1 is a STATE event (the topic moves) inside the page
        await fr.addEvent({
          type: 'm.room.topic',
          state_key: '',
          content: { topic: 'on the wire' },
        });
        await fakeMessage(fr, 'b2');
        await fakeMessage(fr, 'b3');
        await fakeMessage(fr, 'm1');
        await fakeMessage(fr, 'm2');
        const m3 = await fakeMessage(fr, 'm3');
        const genesisIds = [1, 2, 3, 4, 5].map((n) =>
          [...fr.events.values()][n - 1]
        );
        return { live: genesisIds, latest: m3 };
      },
    });
    const fr = s.fr;
    const id = (pdu: Pdu) => String(pdu.event_id);
    const [create] = [...fr.events.values()].slice(0, 5);
    const [a1, a2, a3, b1, b2, b3, m1] = [...fr.events.values()].slice(5);

    // the chase packed the state at m2: the genesis events are live; the
    // b1 topic (state at m2) is held as EVIDENCE
    const changesBefore = await s.room.tx(async (tx) => {
      const rows = await tx.changes.after(0, 100000);
      return rows.length === 0 ? 0 : rows[rows.length - 1].pos;
    });

    // backfill 1: capped at the four newest — the gap stays open behind b1
    const fetch1 = fakeFetcher({
      backfill: (from, limit) => fr.backfillPdus(from, limit),
      stateIds: new Map([[id(b1), fr.stateIdsAt(id(b1))!]]),
    });
    s.deps.fetcher = fetch1.fetcher;
    const r1 = await backfill(
      s.room,
      { from: [id(m1)], limit: 4, via: fr.server.name },
      s.deps,
    );
    assertEquals(r1.outcome, 'filled');

    // the page [m1,b3,b2,b1]: b1's prev (a3) is absent — b1 grounds on
    // the imported boundary; b2..m1 resolve from the page
    const positioned1 = [b1, b2, b3, m1].map(id);
    assertEquals(r1.positioned, positioned1);
    const offsets = await offsetsOf(s.room, positioned1);
    for (let index = 1; index < positioned1.length; index++) {
      const prev = offsets.get(positioned1[index - 1])!;
      const next = offsets.get(positioned1[index])!;
      assertEquals(prev.segment, r1.segment);
      assert(
        prev.offset < next.offset,
        `${positioned1[index - 1]} before ${positioned1[index]}`,
      );
    }
    // the prepended offsets are negative (below the live stay's 0+)
    assert(offsets.get(id(b1))!.offset < 0);

    await s.room.tx(async (tx) => {
      // b1 was held as EVIDENCE from the chase — promoted: grounded,
      // genuine refs, exactly one position (first owner)
      const b1Status = await tx.events.getStatus(id(b1));
      assertEquals(b1Status?.grounding, 'grounded');
      const b1After = await tx.state.eventStateAfter(id(b1));
      assert(b1After !== null && b1After.provenance === 'imported');
      // a history STATE event: before ≠ after; the after-map carries it
      const b1Before = await tx.state.eventStateBefore(id(b1));
      assert(b1Before !== null && b1Before.group !== b1After.group);
      assertEquals(
        await tx.state.groupKey(b1After.group, 'm.room.topic', ''),
        id(b1),
      );
      // G3: m1's single parent aliases — before(m1) IS after(b3)
      const b3After = await tx.state.eventStateAfter(id(b3));
      const m1Before = await tx.state.eventStateBefore(id(m1));
      assertEquals(m1Before?.group, b3After?.group);
    });

    // history is never news: since the live ingest, only 'history'
    // entries — no publication, delivery, membership or live event kinds
    const changes = await s.room.tx((tx) =>
      tx.changes.after(changesBefore, 100000)
    );
    assert(changes.length > 0);
    for (const change of changes) {
      assertEquals(change.kind, 'history');
      const data = JSON.parse(change.data) as { segment: number };
      assertEquals(data.segment, r1.segment);
    }

    // backfill 2 reaches the live genesis — the overlap closes the gap
    const fetch2 = fakeFetcher({
      backfill: (from, limit) => fr.backfillPdus(from, limit),
    });
    s.deps.fetcher = fetch2.fetcher;
    const r2 = await backfill(
      s.room,
      { from: [id(a3)], limit: 10, via: fr.server.name },
      s.deps,
    );
    assertEquals(r2.outcome, 'complete');
    assertEquals(r2.positioned, [id(a1), id(a2), id(a3)]);
    const offsets2 = await offsetsOf(s.room, [id(a1), id(a2), id(a3)]);
    // prepended BELOW the first page — old cursors never renumber
    assert(offsets2.get(id(a3))!.offset < offsets.get(id(b1))!.offset);
    assert(offsets2.get(id(a1))!.offset < offsets2.get(id(a2))!.offset);
    assert(offsets2.get(id(a2))!.offset < offsets2.get(id(a3))!.offset);
    await s.room.tx(async (tx) => {
      const history = await tx.segments.get(r1.segment!);
      assertEquals(history?.status, 'complete');
      // first-owner: the create keeps its LIVE stay position, never a
      // duplicate history position
      const createPos = await tx.segments.positionOf(id(create));
      assert(createPos !== null && createPos.segment !== history!.id);
    });
  });
});

Deno.test('backfill: a forked page where depth order ≠ topological order — per-event DAG state and resolved refs (G4)', async () => {
  await withStore(async (store) => {
    const s = await setup(store, {
      roomId: '!h2:remote.test',
      build: async (fr) => {
        const a1 = await fakeMessage(fr, 'a1');
        // the fork: two competing topic events at adversarial depths,
        // healed by a message DEEPER than neither in depth terms
        const ta = await fr.addEvent({
          type: 'm.room.topic',
          state_key: '',
          content: { topic: 'fork A' },
          depth: 20,
        });
        const tb = await fr.addEvent({
          type: 'm.room.topic',
          state_key: '',
          content: { topic: 'fork B' },
          prev_events: [idOf(a1)],
          depth: 19,
        });
        const b2 = await fr.addEvent({
          type: 'm.room.message',
          content: { msgtype: 'm.text', body: 'heal' },
          prev_events: [idOf(ta), idOf(tb)],
          depth: 10, // hostile: the child is SHALLOWER than its parents
        });
        await fakeMessage(fr, 'm1', { prev_events: [idOf(b2)] });
        await fakeMessage(fr, 'm2');
        const m3 = await fakeMessage(fr, 'm3');
        const genesisIds = [1, 2, 3, 4, 5].map((n) =>
          [...fr.events.values()][n - 1]
        );
        return { live: [...genesisIds, a1], latest: m3 };
      },
    });
    const fr = s.fr;
    const [, ta, tb, b2, m1] = [...fr.events.values()].slice(5);
    const id = (pdu: Pdu) => String(pdu.event_id);

    const fetch1 = fakeFetcher({
      backfill: (from, limit) => fr.backfillPdus(from, limit),
    });
    s.deps.fetcher = fetch1.fetcher;
    const r1 = await backfill(
      s.room,
      { from: [id(m1)], limit: 10, via: fr.server.name },
      s.deps,
    );
    assertEquals(r1.outcome, 'complete'); // a1 is held live — the overlap
    assertEquals(r1.positioned, [id(tb), id(ta), id(b2), id(m1)]);
    // topological, not depth order: both parents precede the SHALLOWER
    // child (depth 10 < 19/20), and m1 follows it
    const offsets = await offsetsOf(s.room, r1.positioned);
    assert(offsets.get(id(ta))!.offset < offsets.get(id(b2))!.offset);
    assert(offsets.get(id(tb))!.offset < offsets.get(id(b2))!.offset);
    assert(offsets.get(id(b2))!.offset < offsets.get(id(m1))!.offset);

    await s.room.tx(async (tx) => {
      // each fork side carries its OWN topic (no depth-linear shared map)
      const taAfter = await tx.state.eventStateAfter(id(ta));
      const tbAfter = await tx.state.eventStateAfter(id(tb));
      assertEquals(
        await tx.state.groupKey(taAfter!.group, 'm.room.topic', ''),
        id(ta),
      );
      assertEquals(
        await tx.state.groupKey(tbAfter!.group, 'm.room.topic', ''),
        id(tb),
      );
      // b2's before is the RESOLVED fork state — the same winner the
      // real rulebook picks over the two stored after-maps
      const b2Before = await tx.state.eventStateBefore(id(b2));
      assert(b2Before !== null && b2Before.provenance === 'dag');
      assert(b2Before.group !== taAfter!.group);
      assert(b2Before.group !== tbAfter!.group);
      const expected = await getRulebook('11').resolveState(
        [
          await tx.state.groupMap(taAfter!.group),
          await tx.state.groupMap(tbAfter!.group),
        ],
        {
          get: (eventId: string) => {
            const pdu = fr.events.get(eventId);
            return pdu;
          },
          isRejected: () => false,
        },
      );
      const actual = await tx.state.groupMap(b2Before.group);
      assertEquals(actual, expected);
      // b2 grounded (never evidence) despite the hostile depth
      const b2Status = await tx.events.getStatus(id(b2));
      assertEquals(b2Status?.grounding, 'grounded');
    });
  });
});

function idOf(pdu: Pdu): string {
  return String(pdu.event_id);
}

Deno.test('backfill: a page-edge state event takes the imported boundary; a failing state_ids lands evidence', async () => {
  await withStore(async (store) => {
    // room A: the page edge is a STATE event — before comes from
    // /state_ids, after = boundary + its own key (G1/G3)
    const s = await setup(store, {
      roomId: '!h3:remote.test',
      build: async (fr) => {
        await fr.addEvent({
          type: 'm.room.topic',
          state_key: '',
          content: { topic: 'edge' },
        });
        await fakeMessage(fr, 'm1');
        await fakeMessage(fr, 'm2');
        const m3 = await fakeMessage(fr, 'm3');
        // hv is NOT ingested live: t1's prev stays absent — the edge case
        const genesisIds = [1, 2, 3, 4].map((n) =>
          [...fr.events.values()][n - 1]
        );
        return { live: genesisIds, latest: m3 };
      },
    });
    const fr = s.fr;
    const [, , , , , t1, m1] = [...fr.events.values()];
    const fetchA = fakeFetcher({
      backfill: (from, limit) => fr.backfillPdus(from, limit),
      stateIds: new Map([
        [idOf(m1), fr.stateIdsAt(idOf(m1))!],
        [idOf(t1), fr.stateIdsAt(idOf(t1))!],
      ]),
      event: new Map(
        [...fr.events.entries()].map(([eventId, pdu]) => [eventId, pdu]),
      ),
    });
    s.deps.fetcher = fetchA.fetcher;
    // limit 1: the page is m1 alone — its prev (t1) is absent
    const r1 = await backfill(
      s.room,
      { from: [idOf(m1)], limit: 1, via: fr.server.name },
      s.deps,
    );
    assertEquals(r1.outcome, 'filled');
    assertEquals(fetchA.calls.stateIds, [idOf(m1)]);
    await s.room.tx(async (tx) => {
      const before = await tx.state.eventStateBefore(idOf(m1));
      assert(before !== null && before.provenance === 'imported');
      assertEquals(
        await tx.state.groupKey(before.group, 'm.room.topic', ''),
        idOf(t1),
      );
    });
    // page 2: t1 alone at the edge — a history STATE event (before ≠
    // after), its before the imported answer
    const r2 = await backfill(
      s.room,
      { from: [idOf(t1)], limit: 1, via: fr.server.name },
      s.deps,
    );
    assertEquals(r2.outcome, 'filled');
    await s.room.tx(async (tx) => {
      const before = await tx.state.eventStateBefore(idOf(t1));
      const after = await tx.state.eventStateAfter(idOf(t1));
      assert(before !== null && before.provenance === 'imported');
      assert(after !== null && after.group !== before.group);
      // the boundary is the state BEFORE t1: no topic there yet
      assertEquals(
        await tx.state.groupKey(before.group, 'm.room.topic', ''),
        null,
      );
      assertEquals(
        await tx.state.groupKey(after.group, 'm.room.topic', ''),
        idOf(t1),
      );
      assertEquals((await tx.segments.positionOf(idOf(t1))) !== null, true);
    });

    // room B: state_ids fails for the edge event — evidence, never
    // state-at, never positioned; the gap stays open
    const sb = await setup(store, {
      roomId: '!h3b:remote.test',
      build: async (fr) => {
        await fakeMessage(fr, 'm1');
        await fakeMessage(fr, 'm2');
        const m3 = await fakeMessage(fr, 'm3');
        // hv held back: m1's prev is absent at the page edge
        const genesisIds = [1, 2, 3, 4].map((n) =>
          [...fr.events.values()][n - 1]
        );
        return { live: genesisIds, latest: m3 };
      },
    });
    const frB = sb.fr;
    const [bm1] = [...frB.events.values()].slice(5);
    const fetchB = fakeFetcher({
      backfill: (from, limit) => frB.backfillPdus(from, limit),
      // no stateIds scripted → the fake answers null
    });
    sb.deps.fetcher = fetchB.fetcher;
    const rb = await backfill(
      sb.room,
      { from: [idOf(bm1)], limit: 1, via: frB.server.name },
      sb.deps,
    );
    assertEquals(rb.outcome, 'open');
    await sb.room.tx(async (tx) => {
      const status = await tx.events.getStatus(idOf(bm1));
      assertEquals(status?.grounding, 'evidence');
      assertEquals(await tx.state.eventStateAfter(idOf(bm1)), null);
      assertEquals(await tx.segments.positionOf(idOf(bm1)), null);
    });
  });
});
