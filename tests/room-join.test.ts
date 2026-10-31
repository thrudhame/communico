// tests/room-join.test.ts — joining a room hosted elsewhere (3c-2):
// the returned snapshot becomes the imported boundary of a new stay
// (sole extremity, evidence, publication, membership change); via
// fail-over on network failure and 404, abort on 403; a snapshot with
// an unauthorized state event is refused and no room file is created;
// a returned join that does not match ours is refused.
import { assert, assertEquals, assertRejects } from '@std/assert';
import type { Pdu } from '#engine/pdu.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { joinRemote } from '#engine/room/join.ts';
import { openRoom, type Room, roomSchema } from '#engine/room/index.ts';
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

async function joinDepsFor(fr: FakeRoom) {
  const { fetcher, calls } = fakeFetcher({
    makeJoin: (userId) => fr.makeJoinAnswer(userId),
    sendJoin: (event) => fr.acceptSendJoin(event),
  });
  return {
    calls,
    deps: {
      keys: fakeKeyResolver(fr.server, await testRemoteServer()),
      fetcher,
      self: 'test',
    },
  };
}

async function frontierOf(room: Room): Promise<string[]> {
  return await room.tx(async (tx) => {
    const stay = await tx.segments.openStay();
    return stay === null ? [] : await tx.extremities.frontier(stay.id);
  });
}

Deno.test('join remote: the snapshot becomes the imported boundary of a new stay', async () => {
  await withStore(async (store) => {
    const fr = await makeFakeRoom({ roomId: '!j1:remote.test' });
    await fakeMessage(fr, 'hello before we arrive');
    await fakeMessage(fr, 'the wire moves');
    const { deps, calls } = await joinDepsFor(fr);
    const signer = await testSigner();

    const result = await joinRemote(store, {
      roomId: fr.roomId,
      user: ANNA,
      via: [fr.server.name],
      signer,
      deps,
    });
    assertEquals(result.roomId, fr.roomId);
    assert(calls.makeJoin.length === 1);
    assert(calls.sendJoin.length === 1);

    const room = await openRoom(store, fr.roomId);
    assertEquals(await frontierOf(room), [result.eventId]);
    await room.tx(async (tx) => {
      const stay = (await tx.segments.openStay())!;
      assertEquals(stay.opened_by, result.eventId);
      // the join is positioned at the stay's origin
      assertEquals(
        await tx.segments.positionOf(result.eventId),
        { segment: stay.id, offset: 0 },
      );
      // its before-state IS the stay's opening group, provenance
      // imported (G1) — the snapshot, never recomputed
      const before = await tx.state.eventStateBefore(result.eventId);
      assert(before !== null && before.provenance === 'imported');
      assertEquals(stay.opening_group, before.group);
      // the snapshot events are evidence: bytes, no refs, no positions
      for (const id of [fr.createId, fr.powerLevelsId]) {
        const status = await tx.events.getStatus(id);
        assertEquals(status?.grounding, 'evidence');
        assertEquals(await tx.state.eventStateAfter(id), null);
        assertEquals(await tx.segments.positionOf(id), null);
      }
      // the snapshot carries the fake room's state
      assertEquals(
        await tx.state.groupKey(before.group, 'm.room.create', ''),
        fr.createId,
      );
      // the published current state has anna joined
      const current = await tx.state.current(stay.id);
      const annaId = current === null
        ? null
        : await tx.state.groupKey(current, 'm.room.member', ANNA);
      assert(annaId !== null && annaId === result.eventId);
      // the change log: the membership change and the publication, no
      // delivery intent (the resident fans the join out — we don't)
      const changes = await tx.changes.after(0, 100000);
      const membership = changes.filter((c) => c.kind === 'membership');
      assertEquals(membership.length, 1);
      assertEquals(
        JSON.parse(membership[0].data),
        { user: ANNA, from: null, to: 'join' },
      );
      const delivery = changes.filter((c) => c.kind === 'delivery');
      assertEquals(delivery.length, 0);
      // the publication moved past the opening group (the join is in)
      const published = await tx.state.publishedAt(
        stay.id,
        Number.MAX_SAFE_INTEGER,
      );
      assert(published !== null && published !== stay.opening_group);
      // the join's own event entry: grounded, the via as origin
      const joinEntry = changes.filter((c) =>
        c.kind === 'event' && c.event === result.eventId
      );
      assertEquals(joinEntry.length, 1);
      const data = JSON.parse(joinEntry[0].data) as {
        grounding: string;
        origin: string;
        stay: number;
      };
      assertEquals(data.grounding, 'grounded');
      assertEquals(data.origin, fr.server.name);
      assertEquals(data.stay, stay.id);
    });
  });
});

Deno.test('join remote: fail-over on network failure and 404; abort on 403', async () => {
  await withStore(async (store) => {
    const fr = await makeFakeRoom({ roomId: '!j2:remote.test' });
    const signer = await testSigner();
    const selfKeys = await testRemoteServer();
    // a dead first candidate (network error), the fake second
    const dead = fakeFetcher({
      makeJoin: () => {
        throw new Error('connection refused');
      },
    });
    const { deps } = await joinDepsFor(fr);
    deps.fetcher = {
      ...deps.fetcher,
      makeJoin: (roomId, userId, versions, via) => {
        if (via === 'dead.test') {
          return dead.fetcher.makeJoin(roomId, userId, versions, via);
        }
        return Promise.resolve(fr.makeJoinAnswer(userId));
      },
      sendJoin: (_roomId, event, _via) => fr.acceptSendJoin(event),
    };
    const result = await joinRemote(store, {
      roomId: fr.roomId,
      user: ANNA,
      via: ['dead.test', fr.server.name],
      signer,
      deps,
    });
    assertEquals(result.roomId, fr.roomId);

    // a 404 M_NOT_FOUND from make_join fails over the same way
    const fr404 = await makeFakeRoom({ roomId: '!j2b:remote.test' });
    const gone = fakeFetcher({
      makeJoin: (_userId, via) => {
        if (via === 'gone.test') {
          throw new MatrixError(404, 'M_NOT_FOUND', 'not here');
        }
        return fr404.makeJoinAnswer(_userId);
      },
      sendJoin: (event) => fr404.acceptSendJoin(event),
    });
    const result404 = await joinRemote(store, {
      roomId: fr404.roomId,
      user: ANNA,
      via: ['gone.test', fr404.server.name],
      signer,
      deps: {
        keys: fakeKeyResolver(fr404.server, selfKeys),
        fetcher: gone.fetcher,
        self: 'test',
      },
    });
    assertEquals(result404.roomId, fr404.roomId);

    // a 403 aborts — no fail-over, no room file
    const fr403 = await makeFakeRoom({ roomId: '!j2c:remote.test' });
    const forbidden = fakeFetcher({
      makeJoin: () => {
        throw new MatrixError(403, 'M_FORBIDDEN', 'banned');
      },
    });
    const err = await assertRejects(() =>
      joinRemote(store, {
        roomId: fr403.roomId,
        user: ANNA,
        via: [fr403.server.name],
        signer,
        deps: {
          keys: fakeKeyResolver(fr403.server, selfKeys),
          fetcher: forbidden.fetcher,
          self: 'test',
        },
      })
    );
    assert(String(err).includes('M_FORBIDDEN'));
    await assertRejects(() => openRoom(store, fr403.roomId));
  });
});

Deno.test('join remote: an unauthorized state event or a mismatched join refuses the response — no room file', async () => {
  await withStore(async (store) => {
    const signer = await testSigner();
    const selfKeys = await testRemoteServer();

    // room A: the snapshot carries a state event that fails its auth
    // check (a topic with no auth events at all — rule 2)
    const frA = await makeFakeRoom({ roomId: '!j3:remote.test' });
    const badTopic = await remoteEvent(frA.roomId, frA.server, '11', {
      type: 'm.room.topic',
      sender: frA.creator,
      state_key: '',
      content: { topic: 'forged' },
      prev_events: [frA.tipId],
      auth_events: [],
      depth: 50,
    });
    const tamperedA = fakeFetcher({
      makeJoin: (userId) => frA.makeJoinAnswer(userId),
      sendJoin: (event) =>
        frA.acceptSendJoin(event, (resp) => {
          resp.state.push(badTopic);
        }),
    });
    const errA = await assertRejects(() =>
      joinRemote(store, {
        roomId: frA.roomId,
        user: ANNA,
        via: [frA.server.name],
        signer,
        deps: {
          keys: fakeKeyResolver(frA.server, selfKeys),
          fetcher: tamperedA.fetcher,
          self: 'test',
        },
      })
    );
    assert(String(errA).includes('M_UNKNOWN'), String(errA));
    await assertRejects(() => openRoom(store, frA.roomId));

    // room B: the returned join does not match ours — a keep-listed
    // field is tampered, so the recomputed id differs
    const frB = await makeFakeRoom({ roomId: '!j3b:remote.test' });
    const tamperedB = fakeFetcher({
      makeJoin: (userId) => frB.makeJoinAnswer(userId),
      sendJoin: (event) =>
        frB.acceptSendJoin(event, (resp) => {
          resp.event = {
            ...(resp.event as unknown as Record<string, unknown>),
            content: { membership: 'invite' },
          } as unknown as Pdu;
        }),
    });
    const errB = await assertRejects(() =>
      joinRemote(store, {
        roomId: frB.roomId,
        user: ANNA,
        via: [frB.server.name],
        signer,
        deps: {
          keys: fakeKeyResolver(frB.server, selfKeys),
          fetcher: tamperedB.fetcher,
          self: 'test',
        },
      })
    );
    assert(String(errB).includes('M_UNKNOWN'), String(errB));
    await assertRejects(() => openRoom(store, frB.roomId));
  });
});
