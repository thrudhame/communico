// F4: room read fallbacks are not evidence of projected membership.
import { assert, assertEquals } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import { eduState } from '#engine/federation/edus.ts';
import { listWitnesses } from '#engine/federation/peers.ts';
import { domainOf } from '#engine/federation/pdu.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { joinRemote } from '#engine/room/join.ts';
import { leave } from '#engine/room/membership.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { joinedUsers } from '#engine/server/directory.ts';
import { membershipOf } from '#engine/server/read.ts';
import { project, sourceOf } from '#engine/server/project.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { eventStreamMax } from '#engine/server/stream.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { type Conn, type Database, operations } from '#engine/store/db.ts';
import { get as watermark } from '#engine/store/watermark.ts';
import { fakeFetcher, fakeKeyResolver } from '#tests/fixtures/remote.ts';
import { makeFakeRoom } from '#tests/fixtures/remote-room.ts';
import { testRemoteServer, testSigner } from '#tests/fixtures/signer.ts';
import { setTyping } from '#engine/typing.ts';

const ANNA = '@anna:test';
const BOB = '@bob:remote.test';
const EVE = '@eve:remote.test';
const GONE = '@gone:remote.test';

async function withStore(fn: (store: Store) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: 'f4-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema, server: serverSchema } });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function setup(store: Store, suffix: string) {
  const fr = await makeFakeRoom({
    roomId: '!f4-' + suffix + ':remote.test',
    joinRule: 'public',
  });
  for (const user of [BOB, EVE, GONE]) {
    await fr.addEvent({
      type: 'm.room.member',
      sender: user,
      state_key: user,
      content: { membership: 'join' },
    });
  }
  const signer = await testSigner();
  const keys = fakeKeyResolver(fr.server, await testRemoteServer());
  const omitted = new Set<string>();
  const transport = fakeFetcher({
    makeJoin: (u) => fr.makeJoinAnswer(u),
    sendJoin: (p) =>
      fr.acceptSendJoin(p, (response) => {
        response.state = response.state.filter((event) =>
          !omitted.has(String(event.state_key))
        );
      }),
  });
  const deps = { self: 'test', keys, fetcher: transport.fetcher };
  const enter = () =>
    joinRemote(store, {
      roomId: fr.roomId,
      user: ANNA,
      via: [fr.server.name],
      signer,
      deps,
    });
  const first = await enter();
  const room = await openRoom(store, fr.roomId);
  const server = await store.server();
  const members = () =>
    server.query(
      'SELECT user,membership,event,seq FROM memberships WHERE room=? ORDER BY user',
      [fr.roomId],
    );
  return {
    fr,
    signer,
    keys,
    deps,
    enter,
    first,
    room,
    server,
    members,
    omitted,
  };
}

Deno.test('F4: fresh remote join projects all imported members at its live cut, never imported evidence', async () => {
  await withStore(async (store) => {
    const s = await setup(store, 'fresh');
    await project(store, s.room.id);
    const rows = await s.members();
    assertEquals(
      rows.map((r) => r.user),
      [ANNA, BOB, EVE, GONE, s.fr.creator].sort(),
    );
    const feed = await s.server.query(
      'SELECT seq,event FROM feed WHERE room=? ORDER BY seq',
      [s.room.id],
    );
    assertEquals(feed.length, 1);
    assertEquals(feed[0].event, s.first.eventId);
    for (const row of rows) {
      assertEquals(row.membership, 'join');
      assertEquals(row.seq, feed[0].seq);
      if (row.user !== ANNA) {
        const event = await s.room.tx((tx) => tx.events.get(String(row.event)));
        assertEquals(event?.state_key, row.user);
        const index = await s.server.query(
          'SELECT seq,grounding FROM event_index WHERE event=?',
          [String(row.event)],
        );
        assertEquals(index[0].seq, null);
        assertEquals(index[0].grounding, 'evidence');
      }
    }
    // The opening-group fallback remains the room read contract.
    await s.room.tx(async (tx) => {
      const stay = (await tx.segments.openStay())!;
      const pos = (await tx.changes.posOf(s.first.eventId))!;
      assertEquals(
        await tx.state.publishedAt(stay.id, pos - 1),
        stay.opening_group,
      );
    });
    const before = await s.members();
    const high = await eventStreamMax(s.server);
    const mark = await watermark(s.server, sourceOf(s.room.id));
    await project(store, s.room.id);
    await project(store, s.room.id);
    assertEquals(await s.members(), before);
    assertEquals(await eventStreamMax(s.server), high);
    assertEquals(await watermark(s.server, sourceOf(s.room.id)), mark);
  });
});

Deno.test('F4: rejoin reconciles changed imported keys and preserves unchanged sequence positions', async () => {
  await withStore(async (store) => {
    const s = await setup(store, 'rejoin');
    // Give the first stay ordinary live updates so even the old projector
    // holds every remote member before the rejoin boundary is exercised.
    for (const user of [BOB, EVE, GONE, s.fr.creator]) {
      const pdu = await s.fr.addEvent({
        type: 'm.room.member',
        sender: user,
        state_key: user,
        content: { membership: 'join', displayname: 'before gap' },
      });
      const result = await ingestRemote(s.room, [pdu], s.fr.server.name, {
        ...s.deps,
        limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
        ungroundedMs: 3600000,
      });
      assertEquals(result[0].outcome, 'accepted');
    }
    await leave(s.room, ANNA, s.signer);
    await project(store, s.room.id);
    const before = new Map((await s.members()).map((r) => [String(r.user), r]));
    assert(before.has(BOB) && before.has(EVE) && before.has(s.fr.creator));
    const bobLeft = await s.fr.addEvent({
      type: 'm.room.member',
      sender: BOB,
      state_key: BOB,
      content: { membership: 'leave' },
    });
    const newUser = '@new:remote.test';
    const added = await s.fr.addEvent({
      type: 'm.room.member',
      sender: newUser,
      state_key: newUser,
      content: { membership: 'join' },
    });
    const renamed = await s.fr.addEvent({
      type: 'm.room.member',
      sender: s.fr.creator,
      state_key: s.fr.creator,
      content: { membership: 'join', displayname: 'after gap' },
    });
    s.omitted.add(GONE);
    const second = await s.enter();
    await project(store, s.room.id);
    const after = new Map((await s.members()).map((r) => [String(r.user), r]));
    const cut =
      (await s.server.query('SELECT seq FROM feed WHERE room=? AND event=?', [
        s.room.id,
        second.eventId,
      ]))[0].seq;
    assertEquals(after.get(EVE), before.get(EVE));
    assertEquals(
      after.has(GONE),
      false,
      'a missing published key removes the stale server row',
    );
    assertEquals(after.get(s.fr.creator)?.event, renamed.event_id);
    assertEquals(after.get(s.fr.creator)?.seq, cut);
    assertEquals(after.get(BOB)?.membership, 'leave');
    assertEquals(after.get(BOB)?.event, bobLeft.event_id);
    assertEquals(after.get(BOB)?.seq, cut);
    assertEquals(after.get(newUser)?.event, added.event_id);
    assertEquals(after.get(newUser)?.seq, cut);
    assertEquals(after.get(ANNA)?.seq, cut);
    const feed = await s.server.query(
      'SELECT event,seq FROM feed WHERE room=? ORDER BY seq',
      [s.room.id],
    );
    assertEquals(
      feed.some((r) =>
        r.event === bobLeft.event_id || r.event === added.event_id
      ),
      false,
    );
    const stable = await s.members();
    const high = await eventStreamMax(s.server);
    await project(store, s.room.id);
    assertEquals(await s.members(), stable);
    assertEquals(await eventStreamMax(s.server), high);
    // Force source replay in this disposable store to exercise the
    // (room,pos) idempotency keys, rather than just an up-to-date watermark.
    await s.server.execute('DELETE FROM watermarks WHERE source=?', [
      sourceOf(s.room.id),
    ]);
    await project(store, s.room.id);
    assertEquals(await s.members(), stable);
    assertEquals(await eventStreamMax(s.server), high);
  });
});

Deno.test('F4: imported remote membership passes inbound EDU checks and server discovery', async () => {
  await withStore(async (store) => {
    const s = await setup(store, 'consumers');
    await project(store, s.room.id);
    const edus = eduState(s.server, 'test');
    try {
      await edus.dispatch(s.fr.server.name, {
        edu_type: 'm.typing',
        content: { room_id: s.room.id, user_id: s.fr.creator, typing: true },
      });
      assertEquals(edus.typingOf(s.room.id).userIds, [s.fr.creator]);
      await edus.dispatch(s.fr.server.name, {
        edu_type: 'm.presence',
        content: { push: [{ user_id: s.fr.creator, presence: 'online' }] },
      });
      assertEquals(edus.presenceOf(s.fr.creator)?.presence, 'online');
      assertEquals(
        await joinedUsers(s.server, s.room.id),
        [ANNA, BOB, EVE, GONE, s.fr.creator].sort(),
      );
      assertEquals(
        [...new Set((await joinedUsers(s.server, s.room.id)).map(domainOf))]
          .sort(),
        ['remote.test', 'test'],
      );
      const previousName = config().server.name;
      setConfigForTests({ server: { name: 'test' } });
      try {
        assertEquals(await listWitnesses(s.server, { roomId: s.room.id }), [
          'remote.test',
        ]);
      } finally {
        setConfigForTests({ server: { name: previousName } });
      }
    } finally {
      setTyping(s.room.id, s.fr.creator, false);
    }
  });
});

Deno.test('F4: local creation and same-batch publications retain their own membership cuts', async () => {
  await withStore(async (store) => {
    const signer = await testSigner();
    const made = await createRoom(store, {
      creator: ANNA,
      preset: 'public_chat',
    }, signer);
    const room = await openRoom(store, made.roomId);
    const message = await sendLocal(room, {
      type: 'm.room.message',
      sender: ANNA,
      content: { body: 'after creation' },
    }, signer);
    await project(store, room.id);
    const server = await store.server();
    const first = await membershipOf(server, room.id, ANNA);
    assert(first !== null);
    const feed = await server.query(
      'SELECT seq,event FROM feed WHERE room=? ORDER BY seq',
      [room.id],
    );
    assertEquals(first.eventId, feed[1].event);
    assertEquals(first.seq, feed[1].seq);
    assert(first.eventId !== message.eventId);
    const changed = await sendLocal(room, {
      type: 'm.room.member',
      state_key: ANNA,
      sender: ANNA,
      content: { membership: 'join', displayname: 'changed' },
    }, signer);
    await sendLocal(room, {
      type: 'm.room.message',
      sender: ANNA,
      content: { body: 'after update' },
    }, signer);
    await project(store, room.id);
    const after = await membershipOf(server, room.id, ANNA);
    assertEquals(after?.eventId, changed.eventId);
    const seq =
      (await server.query('SELECT seq FROM feed WHERE room=? AND event=?', [
        room.id,
        changed.eventId,
      ]))[0].seq;
    assertEquals(after?.seq, seq);
    await project(store, room.id);
    assertEquals(await membershipOf(server, room.id, ANNA), after);
  });
});

// Instrument the public database capabilities in this test's own Store.
// No production hooks and no storage behavior is replaced.
function countProjectionReads(store: Store) {
  const counts = {
    roomReads: 0,
    memberEvents: 0,
    memberState: 0,
    serverMembers: 0,
  };
  const room = store.room.bind(store);
  const server = store.server.bind(store);
  const watch = (db: Database, kind: 'room' | 'server') =>
    operations(
      (fn, options) =>
        db.tx((conn) =>
          fn(
            new Proxy(conn, {
              get(target, key) {
                if (key === 'query') {
                  return async (...args: Parameters<Conn['query']>) => {
                    const [sql] = args;
                    if (kind === 'room') {
                      counts.roomReads++;
                      if (sql.includes('state_entries')) counts.memberState++;
                    } else if (sql.includes('memberships')) {
                      counts.serverMembers++;
                    }
                    const rows = await target.query(...args);
                    if (kind === 'room' && sql.includes('FROM events')) {
                      counts.memberEvents += rows.filter((r) =>
                        r.type === 'm.room.member'
                      ).length;
                    }
                    return rows;
                  };
                }
                if (key === 'execute') {
                  return (...args: Parameters<Conn['execute']>) => {
                    if (
                      kind === 'server' && args[0].includes('memberships')
                    ) counts.serverMembers++;
                    return target.execute(...args);
                  };
                }
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ), options),
      db.path,
    );
  store.room = async (...args) => watch(await room(...args), 'room');
  store.server = async () => watch(await server(), 'server');
  return {
    counts,
    restore: () => {
      store.room = room;
      store.server = server;
    },
  };
}

Deno.test('F4 cost: a plain message in a 64-member remote room reads no members and leaves their cursors untouched', async () => {
  await withStore(async (store) => {
    const s = await setup(store, 'cost');
    // Anna + the four setup members + 59 more remote members = 64.
    for (let n = 0; n < 59; n++) {
      const user = '@cost-' + n + ':remote.test';
      await s.fr.addEvent({
        type: 'm.room.member',
        sender: user,
        state_key: user,
        content: { membership: 'join' },
      });
    }
    await leave(s.room, ANNA, s.signer);
    await s.enter();
    await project(store, s.room.id);
    const before = await s.members();
    assertEquals(before.length, 64);
    const sent = await sendLocal(s.room, {
      type: 'm.room.message',
      sender: ANNA,
      content: { body: 'plain message' },
    }, s.signer);
    const measure = countProjectionReads(store);
    try {
      await project(store, s.room.id);
    } finally {
      measure.restore();
    }
    assertEquals(await s.members(), before);
    assertEquals(
      measure.counts.memberEvents,
      0,
      JSON.stringify(measure.counts),
    );
    assertEquals(measure.counts.memberState, 0, JSON.stringify(measure.counts));
    assertEquals(
      measure.counts.serverMembers,
      0,
      JSON.stringify(measure.counts),
    );
    assert(measure.counts.roomReads <= 12, JSON.stringify(measure.counts));
    assertEquals(
      (await s.server.query(
        'SELECT event FROM feed WHERE room=? ORDER BY seq DESC LIMIT 1',
        [s.room.id],
      ))[0].event,
      sent.eventId,
    );
  });
});

Deno.test('F4 cost: moved publications read only changed member events, including successive changes in one batch', async () => {
  await withStore(async (store) => {
    const s = await setup(store, 'changed-cost');
    await project(store, s.room.id);
    for (const name of ['first', 'second']) {
      await sendLocal(s.room, {
        type: 'm.room.member',
        sender: ANNA,
        state_key: ANNA,
        content: { membership: 'join', displayname: name },
      }, s.signer);
    }
    const measure = countProjectionReads(store);
    try {
      await project(store, s.room.id);
    } finally {
      measure.restore();
    }
    // Each changed PDU is read once for its content/search projection and
    // once for its new membership value; unchanged imported members never load.
    assertEquals(
      measure.counts.memberEvents,
      4,
      JSON.stringify(measure.counts),
    );
    const anna = (await s.members()).find((m) => m.user === ANNA)!;
    const event = await s.room.tx((tx) => tx.events.get(String(anna.event)));
    assertEquals(JSON.parse(event!.pdu).content.displayname, 'second');
  });
});
