// tests/room-remote.test.ts — remote PDU ingest (3c-1): verified events
// through the shared pipeline (standing, refs, extremities, publication),
// the redacted-copy rule, refusals before storage, the three-point auth
// sequence, soft-fail, the relaxed remote checks, pending/dropped
// terminals, redelivery receipts, no delivery intent for remote events,
// fetch-phase staleness revalidation, and batch rollback (G11).
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from '@std/assert';
import type { Pdu } from '#engine/pdu.ts';
import type { RemoteDeps } from '#engine/room/deps.ts';
import { type Room, roomSchema } from '#engine/room/index.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { backfill } from '#engine/room/history.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { genesis } from './fixtures/genesis.ts';
import { authAt } from './fixtures/auth.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
  type RemoteServer,
} from './fixtures/remote.ts';

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

type Setup = {
  room: Room;
  roomId: string;
  server: RemoteServer;
  user: string;
  creator: string;
  signer: Awaited<ReturnType<typeof genesis>>['signer'];
  tipId: string;
  createId: string;
  joinId: string;
  deps: RemoteDeps;
  calls: ReturnType<typeof fakeFetcher>['calls'];
};

// A public room with the remote user joined through the remote pipeline,
// so their later events pass the membership rule.
async function remoteSetup(
  store: Store,
  opts: { roomId?: string; deps?: Partial<RemoteDeps> } = {},
): Promise<Setup> {
  const g = await genesis(store, {
    roomId: opts.roomId ?? '!remote:test',
    joinRule: 'public',
  });
  const server = await makeRemoteServer('remote.test');
  const user = '@rudy:remote.test';
  const { fetcher, calls } = fakeFetcher({});
  const deps: RemoteDeps = {
    keys: fakeKeyResolver(server),
    fetcher,
    self: g.signer.serverName,
    limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
    ungroundedMs: 3_600_000,
    ...opts.deps,
  };
  const join = await remoteEvent(g.roomId, server, '11', {
    type: 'm.room.member',
    sender: user,
    state_key: user,
    content: { membership: 'join' },
    prev_events: [g.tipId],
    auth_events: await authAt(g.room, {
      type: 'm.room.member',
      sender: user,
      state_key: user,
      content: { membership: 'join' },
    }, g.tipId),
    origin_server_ts: 100,
  });
  const outcomes = await ingestRemote(g.room, [join], server.name, deps);
  assertEquals(outcomes.length, 1);
  assertEquals(outcomes[0].outcome, 'accepted');
  return {
    room: g.room,
    roomId: g.roomId,
    server,
    user,
    creator: g.creator,
    signer: g.signer,
    tipId: g.tipId,
    createId: g.createId,
    joinId: String(join.event_id),
    deps,
    calls,
  };
}

async function remoteMsg(
  s: Setup,
  body: string,
  prevIds: string[],
  opts: { depth?: number; ts?: number; auth?: string[]; sender?: string },
): Promise<Pdu> {
  return await remoteEvent(s.roomId, s.server, '11', {
    type: 'm.room.message',
    sender: opts.sender ?? s.user,
    content: { msgtype: 'm.text', body },
    prev_events: prevIds,
    auth_events: opts.auth ?? await authAt(s.room, {
      type: 'm.room.message',
      sender: opts.sender ?? s.user,
      content: { body },
    }, s.joinId),
    depth: opts.depth,
    origin_server_ts: opts.ts,
  });
}

async function frontierOf(room: Room): Promise<string[]> {
  return await room.tx(async (tx) => {
    const stay = await tx.segments.openStay();
    return stay === null ? [] : await tx.extremities.frontier(stay.id);
  });
}

Deno.test('key fault ownership: live and historical consumers propagate local faults without publication', async () => {
  await withStore(async (store) => {
    const s = await remoteSetup(store, { roomId: '!keyfault:test' });
    const msg = await remoteMsg(s, 'unpublished', [s.joinId], {});
    const before = await frontierOf(s.room);
    const fault = new Error('local resolver database fault');
    const keys = {
      verifyEventSignature: () => {
        throw fault;
      },
    };
    assertStrictEquals(
      await assertRejects(() =>
        ingestRemote(s.room, [structuredClone(msg)], s.server.name, {
          ...s.deps,
          keys,
        })
      ),
      fault,
    );
    assertStrictEquals(
      await assertRejects(() =>
        backfill(s.room, {
          from: [s.joinId],
          limit: 10,
          via: s.server.name,
          anchor: structuredClone(msg),
        }, { ...s.deps, keys })
      ),
      fault,
    );
    assertEquals(await frontierOf(s.room), before);
    assertEquals(await s.room.tx((tx) => tx.events.get(msg.event_id!)), null);
    assertEquals(
      await s.room.tx((tx) => tx.segments.positionOf(msg.event_id!)),
      null,
    );
  });
});

async function currentKey(
  room: Room,
  type: string,
  stateKey: string,
): Promise<string | null> {
  return await room.tx(async (tx) => {
    const stay = await tx.segments.openStay();
    if (stay === null) return null;
    const group = await tx.state.current(stay.id);
    if (group === null) return null;
    return await tx.state.groupKey(group, type, stateKey);
  });
}

Deno.test('remote: a verified event lands — standing, refs, frontier, publication; no delivery intent', async () => {
  await withStore(async (store) => {
    const s = await remoteSetup(store, { roomId: '!rem1:test' });
    const msg = await remoteMsg(s, 'hello room', [s.joinId], { ts: 200 });
    const outcomes = await ingestRemote(s.room, [msg], s.server.name, s.deps);
    assertEquals(outcomes[0].outcome, 'accepted');
    const eventId = String(msg.event_id);
    await s.room.tx(async (tx) => {
      const status = await tx.events.getStatus(eventId);
      assertEquals(status?.standing, 'accepted');
      assertEquals(status?.grounding, 'grounded');
      assertEquals(status?.origin, 'remote.test');
      // genuine DAG state refs (R5), provenance dag
      const after = await tx.state.eventStateAfter(eventId);
      assert(after !== null && after.provenance === 'dag');
      // positioned on the stay
      assert((await tx.segments.positionOf(eventId)) !== null);
      // NO delivery intent for a remote-origin event (we do not forward)
      const deliveries = (await tx.changes.after(0, 500)).filter((c) =>
        c.kind === 'delivery' && c.event === eventId
      );
      assertEquals(deliveries.length, 0);
    });
    assertEquals(await frontierOf(s.room), [eventId]);
  });
});

Deno.test('remote: a content-hash mismatch is stored as the redacted copy we calculated', async () => {
  await withStore(async (store) => {
    const s = await remoteSetup(store, { roomId: '!rem2:test' });
    const tampered = await remoteMsg(s, 'original', [s.joinId], { ts: 200 });
    tampered.content.body = 'tampered'; // the hash no longer matches
    const outcomes = await ingestRemote(
      s.room,
      [tampered],
      s.server.name,
      s.deps,
    );
    assertEquals(outcomes[0].outcome, 'accepted');
    const row = await s.room.tx((tx) =>
      tx.events.get(String(tampered.event_id))
    );
    assert(row !== null);
    assert(!row.pdu.includes('tampered'), row.pdu);
    assert(!row.pdu.includes('original'), row.pdu);
  });
});

Deno.test('remote: a bad signature or wrong sender domain is refused before storage', async () => {
  await withStore(async (store) => {
    const s = await remoteSetup(store, { roomId: '!rem3:test' });
    const badSig = await remoteMsg(s, 'forged sig', [s.joinId], { ts: 200 });
    (badSig.signatures as Record<string, Record<string, string>>)[
      'remote.test'
    ]['ed25519:1'] = 'AAAA';
    const other = await makeRemoteServer('other.test');
    const wrongDomain = await remoteEvent(s.roomId, other, '11', {
      type: 'm.room.message',
      sender: s.user, // signed by other.test, the sender is on remote.test
      content: { msgtype: 'm.text', body: 'wrong signer' },
      prev_events: [s.joinId],
      auth_events: [s.createId],
      origin_server_ts: 201,
    });
    const deps: RemoteDeps = {
      ...s.deps,
      keys: fakeKeyResolver(s.server, other),
    };
    const outcomes = await ingestRemote(
      s.room,
      [badSig, wrongDomain],
      s.server.name,
      deps,
    );
    assertEquals(outcomes[0].outcome, 'refused');
    assertEquals(outcomes[1].outcome, 'refused');
    assert(String(outcomes[0].error).includes('M_UNAUTHORIZED'));
    assert(String(outcomes[1].error).includes('M_UNAUTHORIZED'));
    // refused BEFORE storage (spec check 2: dropped)
    assertEquals(
      await s.room.tx((tx) => tx.events.get(String(badSig.event_id))),
      null,
    );
    assertEquals(
      await s.room.tx((tx) => tx.events.get(String(wrongDomain.event_id))),
      null,
    );
  });
});

Deno.test('remote: claimed auth events and a non-member write are auth-rejected', async () => {
  await withStore(async (store) => {
    const s = await remoteSetup(store, { roomId: '!rem4:test' });
    // a held topic — a valid event, but (m.room.topic, '') is outside the
    // auth-events selection set of a message (rule 2.2)
    const topic = await sendLocal(s.room, {
      type: 'm.room.topic',
      sender: s.creator,
      state_key: '',
      content: { topic: 'held' },
      origin_server_ts: 150,
    }, s.signer);
    assertEquals(topic.standing, 'accepted');
    const oddAuth = await remoteMsg(s, 'odd auth', [topic.eventId], {
      ts: 200,
      auth: [s.createId, topic.eventId],
    });
    // A stranger (never joined) fails rule 5 at the declared-auth check first.
    const stranger = await remoteMsg(s, 'not a member', [s.joinId], {
      ts: 201,
      sender: '@stranger:remote.test',
    });
    const outcomes = await ingestRemote(
      s.room,
      [oddAuth, stranger],
      s.server.name,
      s.deps,
    );
    assertEquals(outcomes[0].outcome, 'rejected');
    assertEquals(outcomes[0].reason, 'auth');
    assertEquals(outcomes[1].outcome, 'rejected');
    assertEquals(outcomes[1].reason, 'auth');
    await s.room.tx(async (tx) => {
      // both stored (rejection is not a drop), never extremities
      const a = await tx.events.getStatus(String(oddAuth.event_id));
      assertEquals(a?.standing, 'rejected');
      const b = await tx.events.getStatus(String(stranger.event_id));
      assertEquals(b?.standing, 'rejected');
    });
    assertEquals(await frontierOf(s.room), [topic.eventId]);
  });
});

Deno.test('remote: passing the DAG state but not the current state soft-fails (stored, not an extremity, not published)', async () => {
  await withStore(async (store) => {
    const s = await remoteSetup(store, { roomId: '!rem5:test' });
    // dev bans rudy — the ban lands on the live tip
    const ban = await sendLocal(s.room, {
      type: 'm.room.member',
      sender: s.creator,
      state_key: s.user,
      content: { membership: 'ban', reason: 'out' },
      origin_server_ts: 300,
    }, s.signer);
    assertEquals(ban.standing, 'accepted');
    // rudy's message cites the join — before(E) has him joined (passes
    // the DAG state), the current state has him banned (soft-fail)
    const msg = await remoteMsg(s, 'too late', [s.joinId], { ts: 400 });
    const outcomes = await ingestRemote(s.room, [msg], s.server.name, s.deps);
    assertEquals(outcomes[0].outcome, 'soft_failed');
    const eventId = String(msg.event_id);
    await s.room.tx(async (tx) => {
      const status = await tx.events.getStatus(eventId);
      assertEquals(status?.standing, 'soft_failed');
      assertEquals(status?.grounding, 'grounded');
      // not positioned, and the published member is still the ban
      assertEquals(await tx.segments.positionOf(eventId), null);
    });
    assertEquals(await frontierOf(s.room), [ban.eventId]);
    assertEquals(
      await currentKey(s.room, 'm.room.member', s.user),
      ban.eventId,
    );
  });
});

Deno.test('remote: relaxed depth and a consumed-prev fork are accepted with valid declared auth', async () => {
  await withStore(async (store) => {
    const s = await remoteSetup(store, { roomId: '!rem6:test' });
    // an event citing a CONSUMED prev (the join is no longer a frontier
    // tip after the first remote event) is accepted, and a second fork
    // from the same old prev too; depth far off the computed value is
    // not recomputed for remote events
    const first = await remoteMsg(s, 'on the join', [s.joinId], {
      ts: 200,
      depth: 424242,
    });
    const fork = await remoteMsg(s, 'same old prev', [s.joinId], { ts: 201 });
    const outcomes = await ingestRemote(
      s.room,
      [first, fork],
      s.server.name,
      s.deps,
    );
    assertEquals(outcomes[0].outcome, 'accepted');
    assertEquals(outcomes[1].outcome, 'accepted');
    assertEquals(
      await frontierOf(s.room),
      [
        String(first.event_id),
        String(fork.event_id),
      ].sort(),
    );
  });
});

Deno.test('remote: a fork from a remote server resolves deterministically with the local side', async () => {
  await withStore(async (store) => {
    const s = await remoteSetup(store, { roomId: '!rem7:test' });
    // give rudy state power, then fork two topics off the same tip:
    // local cats (ts 1000) vs remote dogs (ts 2000) — equal power, ts
    // ascending, the remote edit wins the key
    const pl = await sendLocal(s.room, {
      type: 'm.room.power_levels',
      sender: s.creator,
      state_key: '',
      content: {
        ban: 50,
        events: {},
        events_default: 0,
        invite: 0,
        kick: 50,
        redact: 50,
        state_default: 50,
        users: { [s.creator]: 100, [s.user]: 100 },
        users_default: 0,
        notifications: { room: 50 },
      },
      origin_server_ts: 500,
    }, s.signer);
    assertEquals(pl.standing, 'accepted');
    const cats = await sendLocal(s.room, {
      type: 'm.room.topic',
      sender: s.creator,
      state_key: '',
      content: { topic: 'cats' },
      prev_events: [pl.eventId],
      origin_server_ts: 1000,
    }, s.signer);
    assertEquals(cats.standing, 'accepted');
    const dogs = await remoteEvent(s.roomId, s.server, '11', {
      type: 'm.room.topic',
      sender: s.user,
      state_key: '',
      content: { topic: 'dogs' },
      prev_events: [pl.eventId],
      // the full auth set a real server selects — same mainline position
      // as the local side, so the tie breaks on the timestamp
      auth_events: [s.createId, pl.eventId, s.joinId],
      origin_server_ts: 2000,
    });
    const outcomes = await ingestRemote(s.room, [dogs], s.server.name, s.deps);
    assertEquals(outcomes[0].outcome, 'accepted');
    assertEquals(
      await frontierOf(s.room),
      [cats.eventId, String(dogs.event_id)].sort(),
    );
    // the heal converges to one extremity; the remote side won the key
    const heal = await sendLocal(s.room, {
      type: 'm.room.message',
      sender: s.creator,
      content: { body: 'heal', msgtype: 'm.text' },
      origin_server_ts: 3000,
    }, s.signer);
    assertEquals(heal.standing, 'accepted');
    assertEquals(await frontierOf(s.room), [heal.eventId]);
    assertEquals(
      await currentKey(s.room, 'm.room.topic', ''),
      String(dogs.event_id),
    );
  });
});

Deno.test('remote: an oversized lenient-version event is stored rejected, never dropped', async () => {
  await withStore(async (store) => {
    // a v10 room (the ≤ v10 create needs content.creator — createRoom's
    // rule, not the plain genesis fixture's)
    const { testSigner } = await import('./fixtures/signer.ts');
    const signer = await testSigner();
    const { createRoom } = await import('#engine/room/create.ts');
    const created = await createRoom(store, {
      creator: '@dev:test',
      version: '10',
      preset: 'public_chat',
    }, signer);
    const { openRoom } = await import('#engine/room/index.ts');
    const room = await openRoom(store, created.roomId);
    const tip = await room.tx(async (tx) => {
      const stay = await tx.segments.openStay();
      const frontier = await tx.extremities.frontier(stay!.id);
      return frontier[0];
    });
    const server = await makeRemoteServer('remote.test');
    const deps: RemoteDeps = {
      keys: fakeKeyResolver(server),
      fetcher: fakeFetcher({}).fetcher,
      self: signer.serverName,
      limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
      ungroundedMs: 3_600_000,
    };
    const hugeKey = '💥'.repeat(300); // 300 codepoints
    const huge = await remoteEvent(created.roomId, server, '10', {
      type: 'my.room.breaker',
      sender: '@rudy:remote.test',
      state_key: hugeKey,
      content: {},
      prev_events: [tip],
      auth_events: [created.createEventId],
      origin_server_ts: 100,
    });
    const outcomes = await ingestRemote(room, [huge], server.name, deps);
    assertEquals(outcomes[0].outcome, 'rejected');
    assertEquals(outcomes[0].reason, 'state');
    assertEquals(outcomes[0].rule, 'oversized');
    const status = await room.tx((tx) =>
      tx.events.getStatus(String(huge.event_id))
    );
    assertEquals(status?.standing, 'rejected');
    assertEquals(status?.grounding, 'grounded');
  });
});

Deno.test('remote: a known event returns the receipt without re-verification; a pending redelivery falls through', async () => {
  await withStore(async (store) => {
    const s = await remoteSetup(store, { roomId: '!rem9:test' });
    const msg = await remoteMsg(s, 'twice', [s.joinId], { ts: 200 });
    const first = await ingestRemote(s.room, [msg], s.server.name, s.deps);
    assertEquals(first[0].outcome, 'accepted');
    const countBefore = await s.room.tx(async (tx) =>
      (await tx.changes.after(0, 500)).length
    );
    // a resolver that verifies NOTHING — the receipt must not re-verify
    const blind: RemoteDeps = {
      ...s.deps,
      keys: fakeKeyResolver(),
    };
    const again = await ingestRemote(s.room, [msg], s.server.name, blind);
    assertEquals(again[0].outcome, 'known');
    const countAfter = await s.room.tx(async (tx) =>
      (await tx.changes.after(0, 500)).length
    );
    assertEquals(countAfter, countBefore);
  });
});

Deno.test('remote: ungroundedmillihours = 0 drops an event whose prevs stay missing', async () => {
  await withStore(async (store) => {
    const s = await remoteSetup(store, {
      roomId: '!rem10:test',
      deps: { ungroundedMs: 0 },
    });
    const orphan = await remoteMsg(s, 'no parents', ['$madeup'], { ts: 200 });
    const outcomes = await ingestRemote(
      s.room,
      [orphan],
      s.server.name,
      s.deps,
    );
    assertEquals(outcomes[0].outcome, 'dropped');
    assertEquals(
      await s.room.tx((tx) => tx.events.get(String(orphan.event_id))),
      null,
    );
  });
});

Deno.test('remote: the fetch phase is revalidated under the lock (G8) — a meanwhile arrival is not lost', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, {
      roomId: '!rem11:test',
      joinRule: 'public',
    });
    const server = await makeRemoteServer('remote.test');
    const user = '@rudy:remote.test';
    const join = await remoteEvent(g.roomId, server, '11', {
      type: 'm.room.member',
      sender: user,
      state_key: user,
      content: { membership: 'join' },
      prev_events: [g.tipId],
      auth_events: await authAt(g.room, {
        type: 'm.room.member',
        sender: user,
        state_key: user,
        content: { membership: 'join' },
      }, g.tipId),
      origin_server_ts: 100,
    });
    // the missing event the pushed PDU waits for
    const missing = await remoteEvent(g.roomId, server, '11', {
      type: 'm.room.message',
      sender: user,
      content: { msgtype: 'm.text', body: 'missing link' },
      prev_events: [String(join.event_id)],
      auth_events: [
        ...await authAt(g.room, {
          type: 'm.room.message',
          sender: user,
          content: {},
        }, g.tipId),
        String(join.event_id),
      ],
      depth: 51,
      origin_server_ts: 150,
    });
    let localId = '';
    const { fetcher, calls } = fakeFetcher({
      missingEvents: [missing],
      onMissingEvents: async () => {
        // WHILE the fetch is in flight (the lock is not held), a local
        // topic lands on the old tip — the batch must see it
        const local = await sendLocal(g.room, {
          type: 'm.room.topic',
          sender: g.creator,
          state_key: '',
          content: { topic: 'meanwhile' },
          origin_server_ts: 160,
        }, g.signer);
        assertEquals(local.standing, 'accepted');
        localId = local.eventId;
      },
    });
    const deps: RemoteDeps = {
      keys: fakeKeyResolver(server),
      fetcher,
      self: g.signer.serverName,
      limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
      ungroundedMs: 3_600_000,
    };
    const joined = await ingestRemote(g.room, [join], server.name, deps);
    assertEquals(joined[0].outcome, 'accepted');
    const pushed = await remoteEvent(g.roomId, server, '11', {
      type: 'm.room.message',
      sender: user,
      content: { msgtype: 'm.text', body: 'pushed' },
      prev_events: [String(join.event_id), String(missing.event_id)],
      auth_events: await authAt(g.room, {
        type: 'm.room.message',
        sender: user,
        content: {},
      }, String(join.event_id)),
      depth: 52,
      origin_server_ts: 170,
    });
    const outcomes = await ingestRemote(g.room, [pushed], server.name, deps);
    assertEquals(outcomes[0].outcome, 'accepted');
    assertEquals(calls.missingEvents.length, 1);
    // the under-lock frontier: the local topic was never consumed and the
    // publication resolves over {local, pushed} — the stale fetch-phase
    // extremities were re-read, not reused
    assertEquals(
      await frontierOf(g.room),
      [localId, String(pushed.event_id)].sort(),
    );
    assertEquals(await currentKey(g.room, 'm.room.topic', ''), localId);
  });
});

Deno.test('remote: a throw mid-batch rolls the room file back (G11)', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, {
      roomId: '!rem12:test',
      joinRule: 'public',
    });
    const server = await makeRemoteServer('remote.test');
    const user = '@rudy:remote.test';
    const join = await remoteEvent(g.roomId, server, '11', {
      type: 'm.room.member',
      sender: user,
      state_key: user,
      content: { membership: 'join' },
      prev_events: [g.tipId],
      auth_events: await authAt(g.room, {
        type: 'm.room.member',
        sender: user,
        state_key: user,
        content: { membership: 'join' },
      }, g.tipId),
      origin_server_ts: 100,
    });
    const missing = await remoteEvent(g.roomId, server, '11', {
      type: 'm.room.message',
      sender: user,
      content: { msgtype: 'm.text', body: 'fetched' },
      prev_events: [String(join.event_id)],
      auth_events: [
        ...await authAt(g.room, {
          type: 'm.room.message',
          sender: user,
          content: {},
        }, g.tipId),
        String(join.event_id),
      ],
      depth: 51,
      origin_server_ts: 150,
    });
    const { fetcher } = fakeFetcher({
      missingEvents: [missing],
      onMissingEvents: async () => {
        // dev (the last joined local member) leaves WHILE the fetch is in
        // flight — the stay closes; the batch must not land
        const leave = await sendLocal(g.room, {
          type: 'm.room.member',
          sender: g.creator,
          state_key: g.creator,
          content: { membership: 'leave' },
          origin_server_ts: 160,
        }, g.signer);
        assertEquals(leave.standing, 'accepted');
      },
    });
    const deps: RemoteDeps = {
      keys: fakeKeyResolver(server),
      fetcher,
      self: g.signer.serverName,
      limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
      ungroundedMs: 3_600_000,
    };
    const joined = await ingestRemote(g.room, [join], server.name, deps);
    assertEquals(joined[0].outcome, 'accepted');
    const pushed = await remoteEvent(g.roomId, server, '11', {
      type: 'm.room.message',
      sender: user,
      content: { msgtype: 'm.text', body: 'pushed' },
      prev_events: [String(join.event_id), String(missing.event_id)],
      auth_events: await authAt(g.room, {
        type: 'm.room.message',
        sender: user,
        content: {},
      }, String(join.event_id)),
      depth: 52,
      origin_server_ts: 170,
    });
    const changesBefore = await g.room.tx(async (tx) =>
      (await tx.changes.after(0, 500)).length
    );
    await assertRejects(
      () => ingestRemote(g.room, [pushed], server.name, deps),
      Error,
      'E_ROOM_ARCHIVED',
    );
    // the whole batch rolled back: neither the fetched event nor the
    // pushed one is stored, and no change entry names either (the leave
    // itself, in its own earlier transaction, legitimately remains)
    assertEquals(
      await g.room.tx((tx) => tx.events.get(String(missing.event_id))),
      null,
    );
    assertEquals(
      await g.room.tx((tx) => tx.events.get(String(pushed.event_id))),
      null,
    );
    await g.room.tx(async (tx) => {
      const batch = (await tx.changes.after(changesBefore, 500)).filter(
        (c) =>
          c.event === String(missing.event_id) ||
          c.event === String(pushed.event_id),
      );
      assertEquals(batch.length, 0);
    });
  });
});
