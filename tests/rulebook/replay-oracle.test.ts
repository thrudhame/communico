// tests/rulebook/replay-oracle.test.ts — the adopt.ts oracle (plan §3e):
// for every DAG built through the engine (author + ingestEvent with
// keepPrevBranches), the incremental state after the healing event must
// EQUAL reresolveFromDag()'s replayed state, row for row. Plus a small
// deterministic fuzz: 20 random DAGs of <= 12 events (members join,
// topics, PL edits, bans).
// Live doltgres (needs the engine + a provisioned server DB).
import { assertEquals } from '@std/assert';
import { createRoom, extremities, lookupRoom } from '#engine/room.ts';
import { author, type AuthorPartial, ingestEvent } from '#engine/ingest.ts';
import { reresolveFromDag } from '#engine/adopt.ts';
import { stateNow } from '#engine/timeline.ts';
import { latestExtremityEventId, resetRoom } from '#tests/util.ts';

// deterministic RNG (mulberry32) — the fuzz is reproducible
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function assertOracle(roomId: string): Promise<void> {
  const room = (await lookupRoom(roomId))!;
  const before = await stateNow(room.dbName);
  await reresolveFromDag(roomId);
  assertEquals(await stateNow(room.dbName), before, 'oracle disagreement');
}

async function send(roomId: string, partial: AuthorPartial): Promise<string> {
  const pdu = await author(roomId, partial);
  const res = await ingestEvent(roomId, pdu, { keepPrevBranches: true });
  return res.event_id;
}

async function randomPrev(
  roomId: string,
  rand: () => number,
): Promise<string[]> {
  const room = (await lookupRoom(roomId))!;
  const xb = await extremities(room.dbName, roomId);
  if (xb.length === 0) throw new Error('no extremities');
  const pick = xb[Math.floor(rand() * xb.length)];
  return [pick.eventId];
}

// --- fixed scenario DAGs ----------------------------------------------------

Deno.test('replay-oracle: ban vs power-level race DAG (engine-built)', async () => {
  const ROOM = '!oracle-banpl:localhost';
  await resetRoom(ROOM);
  await createRoom(ROOM, '11', '@dev:localhost');
  const base = await latestExtremityEventId(ROOM);

  // both branches fork the base; the PL key races
  await send(ROOM, {
    type: 'm.room.power_levels',
    state_key: '',
    sender: '@dev:localhost',
    content: { users: { '@dev:localhost': 100 }, state_default: 0 },
    prev_events: [base],
    origin_server_ts: 1000,
  });
  await send(ROOM, {
    type: 'm.room.power_levels',
    state_key: '',
    sender: '@dev:localhost',
    content: { users: { '@dev:localhost': 100 }, state_default: 100 },
    prev_events: [base],
    origin_server_ts: 2000,
  });
  // heal
  await send(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { body: 'heal', msgtype: 'm.text' },
    prev_events: await (async () => {
      const room = (await lookupRoom(ROOM))!;
      const xb = await extremities(room.dbName, ROOM);
      return xb.map((e) => e.eventId);
    })(),
    origin_server_ts: 3000,
  });
  await assertOracle(ROOM);
});

Deno.test('replay-oracle: three-way fork with a ban DAG (engine-built)', async () => {
  const ROOM = '!oracle-threeway:localhost';
  await resetRoom(ROOM);
  await createRoom(ROOM, '11', '@dev:localhost');
  const base = await latestExtremityEventId(ROOM);

  // three branches: two topics + a ban of an outside user
  await send(ROOM, {
    type: 'm.room.topic',
    state_key: '',
    sender: '@dev:localhost',
    content: { topic: 'one' },
    prev_events: [base],
    origin_server_ts: 1000,
  });
  await send(ROOM, {
    type: 'm.room.member',
    state_key: '@eve:localhost',
    sender: '@dev:localhost',
    content: { membership: 'ban' },
    prev_events: [base],
    origin_server_ts: 1001,
  });
  await send(ROOM, {
    type: 'm.room.topic',
    state_key: '',
    sender: '@dev:localhost',
    content: { topic: 'two' },
    prev_events: [base],
    origin_server_ts: 1002,
  });
  // heal over all three
  await send(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { body: 'heal', msgtype: 'm.text' },
    prev_events: await (async () => {
      const room = (await lookupRoom(ROOM))!;
      const xb = await extremities(room.dbName, ROOM);
      return xb.map((e) => e.eventId);
    })(),
    origin_server_ts: 2000,
  });
  await assertOracle(ROOM);
});

// --- deterministic fuzz ------------------------------------------------------

Deno.test('replay-oracle: 20 random DAGs of <= 12 events agree with the replay', async () => {
  const rand = rng(20260915);
  for (let dag = 0; dag < 20; dag++) {
    const ROOM = `!oracle-fuzz-${dag}:localhost`;
    await resetRoom(ROOM);
    await createRoom(ROOM, '11', '@dev:localhost');
    for (let i = 0; i < 12; i++) {
      const prev = await randomPrev(ROOM, rand);
      const roll = rand();
      let partial: AuthorPartial;
      if (roll < 0.3) {
        partial = {
          type: 'm.room.message',
          sender: '@dev:localhost',
          content: { body: `msg-${dag}-${i}`, msgtype: 'm.text' },
          prev_events: prev,
          origin_server_ts: 1000 + i,
        };
      } else if (roll < 0.55) {
        partial = {
          type: 'm.room.topic',
          state_key: '',
          sender: '@dev:localhost',
          content: { topic: `topic-${dag}-${i}` },
          prev_events: prev,
          origin_server_ts: 1000 + i,
        };
      } else if (roll < 0.75) {
        partial = {
          type: 'm.room.power_levels',
          state_key: '',
          sender: '@dev:localhost',
          // flip state_default between 0 and 50 (both within the
          // creator's 100 — passes rule 9.5)
          content: {
            users: { '@dev:localhost': 100 },
            state_default: i % 2 === 0 ? 0 : 50,
            events_default: 0,
          },
          prev_events: prev,
          origin_server_ts: 1000 + i,
        };
      } else if (roll < 0.9) {
        // ban/kick an outside user — always authorized (creator 100,
        // target 0), exercises member power events in the DAG
        partial = {
          type: 'm.room.member',
          state_key: i % 2 === 0 ? '@eve:localhost' : '@mallory:localhost',
          sender: '@dev:localhost',
          // banning an already-banned user still passes 4.6.2 (target
          // level 0 < sender 100), so repeats are safe here
          content: { membership: 'ban' },
          prev_events: prev,
          origin_server_ts: 1000 + i,
        };
      } else {
        // invite + join a member (two events; the join cites the invite);
        // a UNIQUE member per pair — re-inviting a joined user would be
        // rejected under rule 4.4.3
        const member = `@bob${dag}-${i}:localhost`;
        const invite = await send(ROOM, {
          type: 'm.room.member',
          state_key: member,
          sender: '@dev:localhost',
          content: { membership: 'invite' },
          prev_events: prev,
          origin_server_ts: 1000 + i,
        });
        await send(ROOM, {
          type: 'm.room.member',
          state_key: member,
          sender: member,
          content: { membership: 'join' },
          prev_events: [invite],
          origin_server_ts: 1000 + i,
        });
        continue;
      }
      await send(ROOM, partial);
    }
    // heal over ALL live extremities so the DAG converges to one tip —
    // stateNow() (the tip's view) and the replay (resolved frontier) then
    // must agree row for row
    await send(ROOM, {
      type: 'm.room.message',
      sender: '@dev:localhost',
      content: { body: `heal-${dag}`, msgtype: 'm.text' },
      prev_events: await (async () => {
        const room = (await lookupRoom(ROOM))!;
        const xb = await extremities(room.dbName, ROOM);
        return xb.map((e) => e.eventId);
      })(),
      origin_server_ts: 5000,
    });
    await assertOracle(ROOM);
  }
});
