// tests/server-read.test.ts — the read functions: the feed window and
// maximum, per-user memberships, event → room, the due outbox in send
// order, the relations index and the search candidates with the old
// matching behaviour.
import { assert, assertEquals } from '@std/assert';
import { sendLocal } from '#engine/room/ingest.ts';
import { roomSchema } from '#engine/room/index.ts';
import {
  feedAfter,
  feedMax,
  matchTokens,
  membershipOf,
  outboxDue,
  rankOf,
  relationsOf,
  roomOf,
  roomsFor,
  SEARCH_KEYS,
  searchCandidates,
} from '#engine/server/read.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import type { Db } from '#engine/store/db.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { bobJoins, genesis } from './fixtures/genesis.ts';

installServerHooks();

const LIBRARY = './.native/libturso_ffi.so';

const config = (dir: string) => ({
  dir,
  library: LIBRARY,
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

async function withStore(
  fn: (store: Store, server: Db) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(config(dir), {
    schemas: { room: roomSchema, server: serverSchema },
  });
  try {
    await fn(store, await store.server());
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('read: the feed window and its maximum', async () => {
  await withStore(async (store, server) => {
    const g = await genesis(store, { roomId: '!r1:test' });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        (await sendLocal(g.room, {
          type: 'm.room.message',
          sender: g.creator,
          content: { msgtype: 'm.text', body: `feed ${i}` },
          origin_server_ts: 100 + i,
        }, g.signer)).eventId,
      );
    }
    const max = await feedMax(server);
    assertEquals(max, 10); // 5 genesis + 5 messages
    const window = await feedAfter(server, g.roomId, 5, 3);
    assertEquals(window.length, 3);
    assertEquals(
      window.map((row) => row.event),
      ids.slice(0, 3),
    );
    assert(window[0].seq < window[1].seq && window[1].seq < window[2].seq);
    const rest = await feedAfter(server, g.roomId, window[2].seq, 100);
    assertEquals(rest.map((row) => row.event), ids.slice(3));
    assertEquals(await feedAfter(server, g.roomId, max, 100), []);
  });
});

Deno.test('read: rooms of a user by membership, with the forgotten flag', async () => {
  await withStore(async (store, server) => {
    const g = await genesis(store, { roomId: '!r2a:test' });
    const g2 = await genesis(store, { roomId: '!r2b:test' });
    await bobJoins(g, '@bob:remote.test', 1000);
    const rooms = await roomsFor(server, g.creator);
    assertEquals(rooms.length, 2);
    for (const row of rooms) {
      assertEquals(row.membership, 'join');
      assertEquals(row.forgotten, false);
      assert(typeof row.seq === 'number');
    }
    const bob = await membershipOf(server, g.roomId, '@bob:remote.test');
    assert(bob !== null);
    assertEquals(bob.membership, 'join');
    // a forgotten row is user intent, never derived
    await server.execute('INSERT INTO forgotten(user, room) VALUES(?, ?)', [
      g.creator,
      g2.roomId,
    ]);
    const forgottenRooms = await roomsFor(server, g.creator);
    assertEquals(
      forgottenRooms.find((row) => row.roomId === g2.roomId)!.forgotten,
      true,
    );
    assertEquals(
      forgottenRooms.find((row) => row.roomId === g.roomId)!.forgotten,
      false,
    );
    // no membership row → null (the reads default that to leave)
    assertEquals(await membershipOf(server, g.roomId, '@nobody:test'), null);
    // bob leaves: the row follows the projection
    await sendLocal(g.room, {
      type: 'm.room.member',
      sender: '@bob:remote.test',
      state_key: '@bob:remote.test',
      content: { membership: 'leave' },
      origin_server_ts: 2000,
    }, g.signer);
    assertEquals(
      (await membershipOf(server, g.roomId, '@bob:remote.test'))!.membership,
      'leave',
    );
  });
});

Deno.test('read: event → room', async () => {
  await withStore(async (store, server) => {
    const g = await genesis(store, { roomId: '!r3:test' });
    assertEquals(await roomOf(server, g.createId), g.roomId);
    assertEquals(await roomOf(server, '$nope:test'), null);
  });
});

Deno.test('read: the due outbox, in send order, pending and due only', async () => {
  await withStore(async (store, server) => {
    const g = await genesis(store, { roomId: '!r4:test', joinRule: 'public' });
    await bobJoins(g, '@bob:remote.test', 1000);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        (await sendLocal(g.room, {
          type: 'm.room.message',
          sender: g.creator,
          content: { msgtype: 'm.text', body: `owed ${i}` },
          origin_server_ts: 1010 + i,
        }, g.signer)).eventId,
      );
    }
    const due = await outboxDue(server, 'remote.test', Date.now(), 50);
    // bob's invite and join, then the three messages, in feed order
    assertEquals(due.length, 5);
    assertEquals(due.map((row) => row.event).slice(2), ids);
    for (const row of due) {
      assertEquals(row.destination, 'remote.test');
      assertEquals(row.attempts, 0);
    }
    // not due yet → excluded; sent → excluded
    await server.execute(
      `UPDATE outbox SET next_attempt_ms = ? WHERE event = ?`,
      [Date.now() + 3_600_000, ids[0]],
    );
    await server.execute(
      `UPDATE outbox SET state = 'sent' WHERE event = ?`,
      [ids[1]],
    );
    const left = await outboxDue(server, 'remote.test', Date.now(), 50);
    assertEquals(left.length, 3); // invite, join, the third message
    assertEquals(left.map((row) => row.event).includes(ids[0]), false);
    assertEquals(left.map((row) => row.event).includes(ids[1]), false);
    assertEquals(left.map((row) => row.event).includes(ids[2]), true);
    // another destination has nothing
    assertEquals(await outboxDue(server, 'elsewhere.test', Date.now(), 50), []);
  });
});

Deno.test('read: relations of an event, oldest first, relType optional', async () => {
  await withStore(async (store, server) => {
    const g = await genesis(store, { roomId: '!r5:test' });
    const root = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { msgtype: 'm.text', body: 'root' },
      origin_server_ts: 100,
    }, g.signer);
    const thread = (body: string, ts: number) =>
      sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: {
          msgtype: 'm.text',
          body,
          'm.relates_to': { event_id: root.eventId, rel_type: 'm.thread' },
        },
        origin_server_ts: ts,
      }, g.signer);
    const a = await thread('reply a', 101);
    const b = await thread('reply b', 102);
    const edit = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: {
        msgtype: 'm.text',
        body: '* edited',
        'm.new_content': { msgtype: 'm.text', body: 'edited' },
        'm.relates_to': { event_id: root.eventId, rel_type: 'm.replace' },
      },
      origin_server_ts: 103,
    }, g.signer);
    const all = await relationsOf(server, g.roomId, root.eventId);
    assertEquals(
      all.map((row) => row.eventId),
      [a.eventId, b.eventId, edit.eventId],
    );
    assertEquals(all[0].relType, 'm.thread');
    const threads = await relationsOf(
      server,
      g.roomId,
      root.eventId,
      'm.thread',
    );
    assertEquals(threads.map((row) => row.eventId), [a.eventId, b.eventId]);
    const replace = await relationsOf(
      server,
      g.roomId,
      root.eventId,
      'm.replace',
    );
    assertEquals(replace.map((row) => row.eventId), [edit.eventId]);
    assertEquals(await relationsOf(server, g.roomId, '$nope:test'), []);
  });
});

Deno.test('read: search candidates with the old matching and rank', async () => {
  await withStore(async (store, server) => {
    const g = await genesis(store, { roomId: '!r6a:test' });
    const g2 = await genesis(store, { roomId: '!r6b:test' });
    const send = (room: typeof g, body: string, ts: number) =>
      sendLocal(room.room, {
        type: 'm.room.message',
        sender: room.creator,
        content: { msgtype: 'm.text', body },
        origin_server_ts: ts,
      }, room.signer);
    const h1 = await send(g, 'hello world', 100);
    const h2 = await send(g, 'hello hello hello there', 101);
    const unrelated = await send(g, 'unrelated', 102);
    const other = await send(g2, 'hello from the other room', 100);
    await sendLocal(g.room, {
      type: 'm.room.name',
      sender: g.creator,
      state_key: '',
      content: { name: 'hello names' },
      origin_server_ts: 103,
    }, g.signer);
    // scoping by rooms and keys, newest first
    const bodyOnly = await searchCandidates(server, [g.roomId], [
      'content.body',
    ]);
    assertEquals(
      bodyOnly.map((row) => row.eventId),
      [unrelated.eventId, h2.eventId, h1.eventId],
    );
    const both = await searchCandidates(
      server,
      [g.roomId, g2.roomId],
      SEARCH_KEYS,
    );
    assert(both.some((row) => row.eventId === other.eventId));
    assert(both.some((row) => row.eventId === h1.eventId));
    const names = await searchCandidates(server, [g.roomId], ['content.name']);
    assertEquals(names.length, 1);
    // empty scope → nothing
    assertEquals(await searchCandidates(server, [], SEARCH_KEYS), []);
    // the old matching: every token; the old rank: occurrences per word
    const tokens = 'hello there'.toLowerCase().split(/\s+/).filter(Boolean);
    assertEquals(matchTokens(bodyOnly[1].bodyLower, tokens), true);
    assertEquals(matchTokens(bodyOnly[2].bodyLower, tokens), false);
    assertEquals(rankOf('hello hello hello there', ['hello']), 3 / 4);
    assertEquals(rankOf('hello world', ['hello']), 1 / 2);
    // a redacted target drops out of the candidates (the old redacted_by
    // read-time filter)
    await server.execute(
      'INSERT INTO redactions(target, room, event, pos) VALUES(?, ?, ?, ?)',
      [h1.eventId, g.roomId, '$red:test', 1],
    );
    const after = await searchCandidates(server, [g.roomId], ['content.body']);
    assertEquals(after.map((row) => row.eventId), [
      unrelated.eventId,
      h2.eventId,
    ]);
  });
});
