// tests/server-project.test.ts — the projection (R12): every change kind
// lands its derived rows; replaying the same changes changes nothing (row
// counts, seq max); history/evidence/pending get no seq; delivery intents
// become one outbox row per destination; seq is strictly increasing and
// per-room in pos order; the watermark advances in batches of ≤ 500.
import { assert, assertEquals } from '@std/assert';
import type { Row } from '#engine/store/ffi.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { RemoteDeps } from '#engine/room/deps.ts';
import { backfill } from '#engine/room/history.ts';
import { ingestInTx, redactEvent, sendLocal } from '#engine/room/ingest.ts';
import { openRoom, type Room, roomSchema } from '#engine/room/index.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { verify } from '#engine/room/verify.ts';
import { project, sourceOf } from '#engine/server/project.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { relationsOf } from '#engine/server/read.ts';
import { causalOrder } from '#engine/room/order.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  notificationSnapshot,
  roomNotificationCounts,
} from '#engine/server/notifications.ts';
import { get } from '#engine/store/watermark.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { bobJoins, genesis, PL_DEFAULTS } from './fixtures/genesis.ts';
import { authAt } from './fixtures/auth.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
} from './fixtures/remote.ts';
import { fakeMessage, makeFakeRoom } from './fixtures/remote-room.ts';
import { testRemoteServer } from './fixtures/signer.ts';

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
    schemas: { room: roomSchema, server: serverSchema, tenant: tenantSchema },
  });
  try {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('dev', 'Dev');
      await tx.users.insert('bob', 'Bob');
    });
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function rows(
  store: Store,
  sql: string,
  values: (string | number)[] = [],
): Promise<Row[]> {
  const server = await store.server();
  return await server.query(sql, values);
}

async function lastPos(room: Room): Promise<number> {
  return await room.tx(async (tx) => {
    const changes = await tx.changes.after(0, 100000);
    return changes.length === 0 ? 0 : changes[changes.length - 1].pos;
  });
}

Deno.test('project: a genesis room lands indexed, feed and membership rows; replay changes nothing', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!p1:test' });
    await project(store, g.roomId);
    const events = await rows(
      store,
      `SELECT event, standing, grounding, seq FROM event_index
       WHERE room = ? ORDER BY seq`,
      [g.roomId],
    );
    assertEquals(events.length, 5);
    for (const row of events) {
      assertEquals(row.standing, 'accepted');
      assertEquals(row.grounding, 'grounded');
      assert(typeof row.seq === 'number');
    }
    const feed = await rows(
      store,
      `SELECT seq, pos, event, stay FROM feed WHERE room = ? ORDER BY seq`,
      [g.roomId],
    );
    assertEquals(feed.length, 5);
    // seq is strictly increasing and follows the room's change positions
    for (let i = 1; i < feed.length; i++) {
      assert(Number(feed[i].seq) > Number(feed[i - 1].seq));
      assert(Number(feed[i].pos) > Number(feed[i - 1].pos));
    }
    // the create is first, the join second (the genesis order)
    assertEquals(feed[0].event, g.createId);
    const joinSeq = Number(feed[1].seq);
    const membership = await rows(
      store,
      `SELECT membership, event, seq FROM memberships
       WHERE room = ? AND user = ?`,
      [g.roomId, g.creator],
    );
    assertEquals(membership.length, 1);
    assertEquals(membership[0].membership, 'join');
    assertEquals(membership[0].event, feed[1].event);
    assertEquals(Number(membership[0].seq), joinSeq);
    // the watermark is the room's last change position
    const server = await store.server();
    assertEquals(await get(server, sourceOf(g.roomId)), await lastPos(g.room));

    // replay: the same changes project to nothing new (counts, seq max)
    const counts = async () => {
      const out: Record<string, number> = {};
      for (
        const table of [
          'event_index',
          'feed',
          'memberships',
          'outbox',
          'relations',
          'search',
          'redactions',
        ]
      ) {
        const r = await rows(store, `SELECT COUNT(*) AS n FROM ${table}`);
        out[table] = Number(r[0].n);
      }
      const max = await rows(store, `SELECT MAX(seq) AS m FROM feed`);
      out.maxSeq = max[0].m === null ? 0 : Number(max[0].m);
      return out;
    };
    const before = await counts();
    await project(store, g.roomId);
    await project(store, g.roomId);
    assertEquals(await counts(), before);
  });
});

// The 4c-1 projection gap: a fork resolution can flip a member WITHOUT a
// new membership event (here: a power-levels event on a fork branch
// un-authorizes a ban on the other, so the published member state falls
// back to the shared join). The room emits no membership change for the
// trigger; the projection must follow the published group's member diff
// anyway (the old fold walked every published member row on every
// publish). Unchanged keys are never re-stamped; replay is idempotent.
Deno.test('project: memberships follow the published state across a fork flip without a membership event', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!p-fork:test' });
    const bob = '@bob:test';
    const eve = '@eve:test';
    const bobJoinId = await bobJoins(g, bob, 1000);
    const eveJoinId = await bobJoins(g, eve, 1002);
    // eve at 50 bans bob on one branch (ts 400/500; 50 suffices to ban,
    // and 50 < 100 lets the creator demote her back — rule 9.8)
    const promote = await sendLocal(g.room, {
      type: 'm.room.power_levels',
      sender: g.creator,
      state_key: '',
      content: {
        ...PL_DEFAULTS(g.creator),
        users: { [g.creator]: 100, [eve]: 50 },
      },
      prev_events: [eveJoinId],
      origin_server_ts: 400,
    }, g.signer);
    assertEquals(promote.standing, 'accepted');
    const ban = await sendLocal(g.room, {
      type: 'm.room.member',
      sender: eve,
      state_key: bob,
      content: { membership: 'ban' },
      prev_events: [promote.eventId],
      origin_server_ts: 500,
    }, g.signer);
    assertEquals(ban.standing, 'accepted');
    await project(store, g.roomId);
    // the membership-event path: the ban landed through its own change
    let bobRows = await rows(
      store,
      'SELECT membership, event, seq FROM memberships WHERE room = ? AND user = ?',
      [g.roomId, bob],
    );
    assertEquals(bobRows.length, 1);
    assertEquals(bobRows[0].membership, 'ban');
    assertEquals(bobRows[0].event, ban.eventId);
    const banSeq = await rows(
      store,
      'SELECT seq FROM feed WHERE room = ? AND event = ?',
      [g.roomId, ban.eventId],
    );
    assertEquals(Number(bobRows[0].seq), Number(banSeq[0].seq));

    // the fork flip: demoting eve on the OTHER branch (a power-levels
    // event — never a membership change) makes the resolution drop the
    // ban; the published member state falls back to bob's shared join
    const demote = await sendLocal(g.room, {
      type: 'm.room.power_levels',
      sender: g.creator,
      state_key: '',
      content: PL_DEFAULTS(g.creator),
      prev_events: [eveJoinId],
      origin_server_ts: 600,
    }, g.signer);
    assertEquals(demote.standing, 'accepted');
    // the premise: the published state flipped with no membership change
    await g.room.tx(async (tx) => {
      const stay = await tx.segments.openStay();
      const group = await tx.state.current(stay!.id);
      assertEquals(
        await tx.state.groupKey(group!, 'm.room.member', bob),
        bobJoinId,
      );
      const changes = await tx.changes.after(0, 10000);
      assert(
        changes.filter((c) => c.kind === 'membership').every((c) =>
          c.event !== demote.eventId
        ),
        'the demote emitted a membership change',
      );
    });
    await project(store, g.roomId);
    bobRows = await rows(
      store,
      'SELECT membership, event, seq FROM memberships WHERE room = ? AND user = ?',
      [g.roomId, bob],
    );
    assertEquals(bobRows.length, 1);
    assertEquals(bobRows[0].membership, 'join');
    assertEquals(bobRows[0].event, bobJoinId);
    // the member event's OWN seq, not the demote's (old ownSeq rule)
    const bobJoinSeq = await rows(
      store,
      'SELECT seq FROM feed WHERE room = ? AND event = ?',
      [g.roomId, bobJoinId],
    );
    assertEquals(Number(bobRows[0].seq), Number(bobJoinSeq[0].seq));
    // an unchanged key is never re-stamped: eve's row is exactly her join
    const eveRows = await rows(
      store,
      'SELECT membership, event, seq FROM memberships WHERE room = ? AND user = ?',
      [g.roomId, eve],
    );
    assertEquals(eveRows.length, 1);
    assertEquals(eveRows[0].membership, 'join');
    assertEquals(eveRows[0].event, eveJoinId);

    // replay: the whole projection runs again and changes nothing
    const snapshot = async () =>
      await rows(
        store,
        'SELECT user, membership, event, seq FROM memberships WHERE room = ? ORDER BY user',
        [g.roomId],
      );
    const before = await snapshot();
    await project(store, g.roomId);
    await project(store, g.roomId);
    assertEquals(await snapshot(), before);
  });
});

Deno.test('project: relations and search from the event content (live only)', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!p2:test' });
    const root = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { msgtype: 'm.text', body: 'Root HERE' },
      origin_server_ts: 100,
    }, g.signer);
    const reply = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: {
        msgtype: 'm.text',
        body: 'thread reply',
        'm.relates_to': { event_id: root.eventId, rel_type: 'm.thread' },
      },
      origin_server_ts: 101,
    }, g.signer);
    // a rich reply is NOT a relations row (old D7)
    await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: {
        msgtype: 'm.text',
        body: 'quoted',
        'm.relates_to': { 'm.in_reply_to': { event_id: root.eventId } },
      },
      origin_server_ts: 102,
    }, g.signer);
    await sendLocal(g.room, {
      type: 'm.room.name',
      sender: g.creator,
      state_key: '',
      content: { name: 'The Room Name' },
      origin_server_ts: 103,
    }, g.signer);
    await project(store, g.roomId);
    const relations = await rows(
      store,
      `SELECT event, relates_to, rel_type, seq FROM relations WHERE room = ?`,
      [g.roomId],
    );
    assertEquals(relations.length, 1);
    assertEquals(relations[0].event, reply.eventId);
    assertEquals(relations[0].relates_to, root.eventId);
    assertEquals(relations[0].rel_type, 'm.thread');
    // the relation's seq is the event's own feed seq
    const feedSeq = await rows(
      store,
      `SELECT seq FROM feed WHERE room = ? AND event = ?`,
      [g.roomId, reply.eventId],
    );
    assertEquals(relations[0].seq, feedSeq[0].seq);
    const search = await rows(
      store,
      `SELECT event, key, body_lower FROM search WHERE room = ? ORDER BY seq`,
      [g.roomId],
    );
    const byKey = new Map(search.map((row) => [String(row.event), row]));
    assertEquals(String(byKey.get(root.eventId)!.key), 'content.body');
    assertEquals(String(byKey.get(root.eventId)!.body_lower), 'root here');
    assertEquals(String(byKey.get(reply.eventId)!.body_lower), 'thread reply');
    assertEquals(search.filter((row) => row.key === 'content.name').length, 1);
    assertEquals(
      String(
        search.find((row) => row.key === 'content.name')!.body_lower,
      ),
      'the room name',
    );
    // the genesis topic-less room indexes nothing else
    assertEquals(search.length, 4);
  });
});

Deno.test('project: delivery intents become one outbox row per destination, once', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, {
      roomId: '!p3:test',
      joinRule: 'public',
    });
    await bobJoins(g, '@bob:remote.test', 1000);
    const msg = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { msgtype: 'm.text', body: 'hello remote' },
      origin_server_ts: 1003,
    }, g.signer);
    await project(store, g.roomId);
    const outbox = await rows(
      store,
      `SELECT room, pos, destination, event, state, attempts
       FROM outbox ORDER BY pos`,
    );
    // bob's invite (the membership target's server), his join and the
    // message each owe remote.test; the genesis events have no remote
    // destination
    assertEquals(outbox.length, 3);
    assertEquals(outbox[0].destination, 'remote.test');
    assertEquals(outbox[1].destination, 'remote.test');
    assertEquals(outbox[2].event, msg.eventId);
    assertEquals(outbox[0].state, 'pending');
    assertEquals(Number(outbox[0].attempts), 0);
    // replay: still exactly these rows
    await project(store, g.roomId);
    assertEquals(
      (await rows(store, `SELECT COUNT(*) AS n FROM outbox`))[0].n,
      3,
    );
    // bob leaves: his server was joined in the before-state
    const leave = await sendLocal(g.room, {
      type: 'm.room.member',
      sender: '@bob:remote.test',
      state_key: '@bob:remote.test',
      content: { membership: 'leave' },
      origin_server_ts: 1004,
    }, g.signer);
    await project(store, g.roomId);
    const after = await rows(store, `SELECT event FROM outbox ORDER BY pos`);
    assertEquals(after.length, 4);
    assertEquals(after[3].event, leave.eventId);
    // the memberships index followed bob through join and leave
    const bob = await rows(
      store,
      `SELECT membership, event, seq FROM memberships
       WHERE room = ? AND user = '@bob:remote.test'`,
      [g.roomId],
    );
    assertEquals(bob.length, 1);
    assertEquals(bob[0].membership, 'leave');
    assertEquals(bob[0].event, leave.eventId);
    const leaveSeq = await rows(
      store,
      `SELECT seq FROM feed WHERE room = ? AND event = ?`,
      [g.roomId, leave.eventId],
    );
    assertEquals(bob[0].seq, leaveSeq[0].seq);
  });
});

Deno.test('project: a rejected event is indexed without a feed row', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!p4:test' });
    // @nobody has no power (users_default 0 < state_default 50)
    const bad = await sendLocal(g.room, {
      type: 'm.room.power_levels',
      sender: '@nobody:test',
      state_key: '',
      content: { users_default: 100 },
      origin_server_ts: 100,
    }, g.signer);
    assertEquals(bad.standing, 'rejected');
    await project(store, g.roomId);
    const rows_ = await rows(
      store,
      `SELECT standing, reason, seq FROM event_index WHERE event = ?`,
      [bad.eventId],
    );
    assertEquals(rows_.length, 1);
    assertEquals(rows_[0].standing, 'rejected');
    assertEquals(rows_[0].reason, 'auth');
    assertEquals(rows_[0].seq, null);
    assertEquals(
      (await rows(store, `SELECT * FROM feed WHERE event = ?`, [bad.eventId]))
        .length,
      0,
    );
    assertEquals(
      (await rows(
        store,
        'SELECT COUNT(*) AS n FROM push_evaluations WHERE event=?',
        [bad.eventId],
      ))[0].n,
      0,
    );
  });
});

Deno.test('project: a redaction effect lands on the target', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!p5:test' });
    const msg = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { msgtype: 'm.text', body: 'redact me' },
      origin_server_ts: 100,
    }, g.signer);
    const redaction = await redactEvent(
      g.room,
      g.creator,
      msg.eventId,
      g.signer,
    );
    await project(store, g.roomId);
    const rows_ = await rows(
      store,
      `SELECT target, event FROM redactions WHERE room = ?`,
      [g.roomId],
    );
    assertEquals(rows_.length, 1);
    assertEquals(rows_[0].target, msg.eventId);
    assertEquals(rows_[0].event, redaction.eventId);
    // replay: one row, unchanged
    await project(store, g.roomId);
    assertEquals(
      (await rows(store, `SELECT COUNT(*) AS n FROM redactions`))[0].n,
      1,
    );
  });
});

Deno.test('project: a pending remote event grounds as a transition (feed row, seq, first position kept)', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, {
      roomId: '!p6:test',
      joinRule: 'public',
    });
    const server = await makeRemoteServer('remote.test');
    const user = '@rudy:remote.test';
    const { fetcher } = fakeFetcher({});
    const deps: RemoteDeps = {
      keys: fakeKeyResolver(server),
      fetcher,
      self: g.signer.serverName,
      limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
      ungroundedMs: 3_600_000,
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
    assertEquals(
      (await ingestRemote(g.room, [join], server.name, deps))[0].outcome,
      'accepted',
    );
    // an event behind a missing prev lands pending; when the prev
    // arrives, the resume driver grounds it (a 'transition' change)
    const missing = await remoteEvent(g.roomId, server, '11', {
      type: 'm.room.message',
      sender: user,
      content: { msgtype: 'm.text', body: 'the missing one' },
      prev_events: [String(join.event_id)],
      auth_events: await authAt(g.room, {
        type: 'm.room.message',
        sender: user,
        content: {},
      }, String(join.event_id)),
      depth: 50,
      origin_server_ts: 1000,
    });
    const orphan = await remoteEvent(g.roomId, server, '11', {
      type: 'm.room.message',
      sender: user,
      content: { msgtype: 'm.text', body: 'held behind' },
      prev_events: [String(missing.event_id)],
      auth_events: await authAt(g.room, {
        type: 'm.room.message',
        sender: user,
        content: {},
      }, String(join.event_id)),
      depth: 51,
      origin_server_ts: 1001,
    });
    const pending = await ingestRemote(g.room, [orphan], server.name, deps);
    assertEquals(pending[0].outcome, 'pending');
    await project(store, g.roomId);
    const before = await rows(
      store,
      `SELECT standing, grounding, seq FROM event_index WHERE event = ?`,
      [String(orphan.event_id)],
    );
    assertEquals(before[0].standing, 'rejected');
    assertEquals(before[0].grounding, 'pending');
    assertEquals(before[0].seq, null);
    assertEquals(
      (await rows(
        store,
        'SELECT COUNT(*) AS n FROM push_evaluations WHERE event=?',
        [String(orphan.event_id)],
      ))[0].n,
      0,
    );
    // deliver the missing prev: the orphan grounds via resumeWaits
    const fetch2 = fakeFetcher({ missingEvents: [] });
    deps.fetcher = fetch2.fetcher;
    const grounded = await ingestRemote(
      g.room,
      [missing],
      server.name,
      deps,
    );
    assertEquals(grounded[0].outcome, 'accepted');
    await project(store, g.roomId);
    const after = await rows(
      store,
      `SELECT standing, grounding, seq FROM event_index WHERE event = ?`,
      [String(orphan.event_id)],
    );
    assertEquals(after[0].standing, 'accepted');
    assertEquals(after[0].grounding, 'grounded');
    assert(typeof after[0].seq === 'number');
    const feedRow = await rows(
      store,
      `SELECT seq, event FROM feed WHERE room = ? AND event = ?`,
      [g.roomId, String(orphan.event_id)],
    );
    assertEquals(feedRow.length, 1);
    assertEquals(after[0].seq, feedRow[0].seq);
    const snapshot = await (await store.server()).tx((tx) =>
      notificationSnapshot(tx, '@dev:test', 0)
    );
    assertEquals(roomNotificationCounts(snapshot.rooms.get(g.roomId)), {
      notification_count: 2,
      highlight_count: 0,
    });
    assertEquals(
      (await rows(
        store,
        'SELECT COUNT(*) AS n FROM notifications WHERE event=? AND user=?',
        [String(orphan.event_id), '@dev:test'],
      ))[0].n,
      1,
    );
    // the remote events get no delivery intent (we do not forward)
    assertEquals(
      (await rows(store, `SELECT COUNT(*) AS n FROM outbox`))[0].n,
      0,
    );
  });
});

Deno.test('project: history is indexed without a seq and never feeds news', async () => {
  await withStore(async (store) => {
    // the fake remote room: genesis lives here, the page backfills
    const fr = await makeFakeRoom({
      roomId: '!p7:test',
      server: await testRemoteServer(),
    });
    await fr.addEvent({
      type: 'm.room.member',
      state_key: '@bob:test',
      content: { membership: 'invite' },
    });
    await fr.addEvent({
      type: 'm.room.member',
      sender: '@bob:test',
      state_key: '@bob:test',
      content: { membership: 'join' },
    });
    const genesisIds = [...fr.events.values()].slice(0, 7);
    const relationRoot = fr.tipId;
    const historicalReply = await fr.addEvent({
      type: 'm.room.message',
      content: {
        body: 'old 1',
        msgtype: 'm.text',
        'm.relates_to': { event_id: relationRoot, rel_type: 'm.reference' },
      },
    });
    await fakeMessage(fr, 'old 2');
    const tip = await fakeMessage(fr, 'at the gap');
    const room = await openRoom(store, fr.roomId, { create: true });
    const keys = fakeKeyResolver(fr.server);
    const create = await verify(genesisIds[0], fr.version, keys, {
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
    const rest = await ingestRemote(
      room,
      genesisIds.slice(1),
      fr.server.name,
      deps,
    );
    for (const outcome of rest) assertEquals(outcome.outcome, 'accepted');
    // A pulled latest event's chase imports the gap tip boundary;
    // the state_ids answer names the missing prev, not the pulled child.
    const gapTip = String(tip.prev_events![0]);
    const fetcher = fakeFetcher({
      missingEvents: [],
      stateIds: new Map([[gapTip, fr.stateIdsAt(gapTip)!]]),
      event: new Map(
        [...fr.events.entries()].map(([id, pdu]) => [id, pdu] as [string, Pdu]),
      ),
    });
    deps.fetcher = fetcher.fetcher;
    const gap = await ingestRemote(room, [tip], fr.server.name, deps, 'pulled');
    assertEquals(gap[0].outcome, 'accepted');
    // now backfill the oldest message into the history segment (the gap
    // tip's prev is the walk's frontier)
    const fetch2 = fakeFetcher({
      backfill: (from, limit) => fr.backfillPdus(from, limit),
    });
    deps.fetcher = fetch2.fetcher;
    const oldest = String(fr.events.get(gapTip)!.prev_events![0]);
    const filled = await backfill(
      room,
      { from: [oldest], limit: 5, via: fr.server.name },
      deps,
    );
    // the page reaches the held genesis events: the gap closes at the
    // create (the overlap cut)
    assertEquals(filled.outcome, 'complete');
    await project(store, room.id);
    // the backfilled event is indexed — seq NULL, no feed row
    const history = await rows(
      store,
      `SELECT ei.event, ei.seq, ei.grounding FROM event_index ei
       WHERE ei.room = ? AND ei.event NOT IN (
         SELECT event FROM feed WHERE room = ?
       ) ORDER BY ei.pos`,
      [room.id, room.id],
    );
    assertEquals(history.length, 1);
    assertEquals(history[0].seq, null);
    const historicalRelations = await relationsOf(
      await store.server(),
      room.id,
      relationRoot,
    );
    assertEquals(historicalRelations.map((row) => row.eventId), [
      historicalReply.event_id,
    ]);
    assertEquals(
      await room.tx((tx) =>
        causalOrder(tx, [
          tip.event_id!,
          historicalReply.event_id!,
          relationRoot,
        ])
      ),
      [relationRoot, historicalReply.event_id, tip.event_id],
    );
    const pdu = await room.tx(async (tx) =>
      await tx.events.get(String(history[0].event))
    );
    assertEquals(
      String((JSON.parse(pdu!.pdu) as Pdu).content?.body ?? ''),
      'old 1',
    );
    // the gap tip landed live; nothing about the page entered the feed,
    // outbox or search
    const feedCount = await rows(
      store,
      `SELECT COUNT(*) AS n FROM feed WHERE room = ?`,
      [room.id],
    );
    const liveCount = 7 /* genesis + invite/join */ +
      2 /* gap tip + pushed tip */;
    assertEquals(Number(feedCount[0].n), liveCount);
    assertEquals(
      (await rows(store, `SELECT COUNT(*) AS n FROM outbox`))[0].n,
      0,
    );
    // the live gap tip and pushed tip are indexed (live messages); the
    // backfilled page is not
    const search = await rows(store, `SELECT event FROM search`);
    assertEquals(search.length, 2);
    assertEquals(
      search.some((row) => row.event === history[0].event),
      false,
    );
    const snapshot = await (await store.server()).tx((tx) =>
      notificationSnapshot(tx, '@bob:test', 0)
    );
    assertEquals(roomNotificationCounts(snapshot.rooms.get(room.id)), {
      notification_count: 2,
      highlight_count: 0,
    });
    assertEquals(
      (await rows(store, 'SELECT event FROM push_evaluations WHERE event=?', [
        String(history[0].event),
      ])).length,
      0,
    );
  });
});

Deno.test('push projection: a soft-failed event with a valid earlier DAG context never notifies', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!push-soft:test' });
    const oldTip = await bobJoins(g);
    await sendLocal(g.room, {
      type: 'm.room.member',
      state_key: '@bob:test',
      sender: g.creator,
      content: { membership: 'ban' },
    }, g.signer);
    const soft = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: '@bob:test',
      prev_events: [oldTip],
      content: { msgtype: 'm.text', body: 'not live' },
    }, g.signer);
    assertEquals(soft.standing, 'soft_failed');
    await project(store, g.roomId);
    assertEquals(
      (await rows(
        store,
        'SELECT COUNT(*) AS n FROM push_evaluations WHERE event=?',
        [soft.eventId],
      ))[0].n,
      0,
    );
    assertEquals(
      (await rows(
        store,
        'SELECT COUNT(*) AS n FROM notifications WHERE event=?',
        [soft.eventId],
      ))[0].n,
      0,
    );
  });
});

Deno.test('project: more than 500 changes project in batches, in order', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!p8:test' });
    await bobJoins(g);
    for (let i = 0; i < 300; i++) {
      await sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: { msgtype: 'm.text', body: `batch message ${i}` },
        origin_server_ts: 1000 + i,
      }, g.signer);
    }
    const total = await lastPos(g.room);
    assert(total > 500, `expected > 500 changes, got ${total}`);
    await project(store, g.roomId);
    const server = await store.server();
    assertEquals(await get(server, sourceOf(g.roomId)), total);
    const feed = await rows(
      store,
      `SELECT seq, pos FROM feed WHERE room = ? ORDER BY seq`,
      [g.roomId],
    );
    // 5 genesis events + invite/join + 300 messages, strictly increasing.
    assertEquals(feed.length, 307);
    const snapshot = await server.tx((tx) =>
      notificationSnapshot(tx, '@bob:test', 0)
    );
    assertEquals(roomNotificationCounts(snapshot.rooms.get(g.roomId)), {
      notification_count: 300,
      highlight_count: 0,
    });
    for (let i = 1; i < feed.length; i++) {
      assert(Number(feed[i].seq) > Number(feed[i - 1].seq));
      assert(Number(feed[i].pos) > Number(feed[i - 1].pos));
    }
    // a replay after the batches is a no-op
    await project(store, g.roomId);
    const max = await rows(store, `SELECT MAX(seq) AS m FROM feed`);
    assertEquals(Number(max[0].m), Number(feed[feed.length - 1].seq));
    const replay = await server.tx((tx) =>
      notificationSnapshot(tx, '@bob:test', 0)
    );
    assertEquals(roomNotificationCounts(replay.rooms.get(g.roomId)), {
      notification_count: 300,
      highlight_count: 0,
    });
  });
});

Deno.test('push projection: a later rejoin does not grant eligibility at an earlier live cut', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!push-visibility:test' });
    await bobJoins(g);
    await sendLocal(g.room, {
      type: 'm.room.history_visibility',
      state_key: '',
      sender: g.creator,
      content: { history_visibility: 'joined' },
    }, g.signer);
    await sendLocal(g.room, {
      type: 'm.room.member',
      state_key: '@bob:test',
      sender: '@bob:test',
      content: { membership: 'leave' },
    }, g.signer);
    const hidden = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: {
        msgtype: 'm.text',
        body: 'not a notification for the later rejoiner',
      },
    }, g.signer);
    await bobJoins(g, '@bob:test', 2000);
    const visible = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { msgtype: 'm.text', body: 'after the rejoin' },
    }, g.signer);
    await project(store, g.roomId);
    const snapshot = await (await store.server()).tx((tx) =>
      notificationSnapshot(tx, '@bob:test', 0)
    );
    assertEquals(roomNotificationCounts(snapshot.rooms.get(g.roomId)), {
      notification_count: 1,
      highlight_count: 0,
    });
    assertEquals(
      (await rows(
        store,
        'SELECT event FROM notifications WHERE user=? AND read_ms IS NULL',
        ['@bob:test'],
      )).map((r) => r.event),
      [visible.eventId],
    );
    assertEquals(
      (await rows(
        store,
        'SELECT event FROM push_evaluations WHERE user=? AND event=?',
        ['@bob:test', hidden.eventId],
      )).length,
      0,
    );
  });
});
