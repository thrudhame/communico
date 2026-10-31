// tests/room-ingest.test.ts — local ingest: persistence and identity,
// format refusals, fork/heal resolution, extremity rules (E4), standing,
// publication, the change log, delivery intents, stay closure (I15),
// rollback atomicity (G11) and the single-prev no-resolution guardrail.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import { eventIdFor, redact } from '#engine/eventid.ts';
import type { Pdu } from '#engine/pdu.ts';
import { buildInTx, resolutionProbe } from '#engine/room/build.ts';
import { type Room, roomSchema } from '#engine/room/index.ts';
import { ingestInTx, ingestLocal, sendLocal } from '#engine/room/ingest.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import type { Signer } from '#engine/room/signer.ts';
import { contentHashOf } from '#engine/signing-primitives.js';
import { openStore, type Store } from '#engine/store/index.ts';
import { bobJoins, genesis, PL_DEFAULTS } from './fixtures/genesis.ts';

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

// Re-hash, re-sign and re-id a tampered PDU, exactly as the build does.
async function resign(pdu: Pdu, signer: Signer, version = '11'): Promise<Pdu> {
  pdu.hashes = { sha256: await contentHashOf(pdu) };
  const redacted = redact(pdu as unknown as Record<string, unknown>, version);
  delete redacted.event_id;
  delete redacted.signatures;
  pdu.signatures = {
    [signer.serverName]: {
      [signer.keyId]: await signer.sign(canonicalJson(redacted)),
    },
  };
  pdu.event_id = await eventIdFor(
    pdu as unknown as Record<string, unknown>,
    version,
  );
  return pdu;
}

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

async function frontierOf(room: Room): Promise<string[]> {
  return await room.tx(async (tx) => {
    const stay = await tx.segments.openStay();
    if (stay === null) return [];
    return await tx.extremities.frontier(stay.id);
  });
}

Deno.test('ingest: persistence and identity — chained messages, one extremity, timeline order', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!ing1:test' });
    const ids: string[] = [];
    for (const [i, body] of ['m1', 'm2', 'm3'].entries()) {
      const r = await sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body, msgtype: 'm.text' },
        origin_server_ts: 100 + i,
      }, g.signer);
      assertEquals(r.standing, 'accepted');
      ids.push(r.eventId);
    }
    // exactly one row per event, the canonical PDU retrievable by id
    await g.room.tx(async (tx) => {
      for (const [i, id] of ids.entries()) {
        const row = await tx.events.get(id);
        assert(row !== null);
        const pdu = JSON.parse(row.pdu) as Pdu;
        assertEquals(pdu.content.body, `m${i + 1}`);
        assertEquals(pdu.prev_events, [i === 0 ? g.tipId : ids[i - 1]]);
        const status = await tx.events.getStatus(id);
        assertEquals(status?.standing, 'accepted');
      }
      // positions are the arrival order (genesis 0..4, messages 5..7)
      const stay = (await tx.segments.openStay())!;
      const page = await tx.segments.positionsPage(stay.id, 0, 'f', 20);
      assertEquals(page.length, 8);
      assertEquals(page[5].event, ids[0]);
      assertEquals(page[7].event, ids[2]);
      // the change log carries one event entry per ingest
      const events = (await tx.changes.after(0, 100)).filter((c) =>
        c.kind === 'event'
      );
      assertEquals(events.length, 8);
    });
    assertEquals(await frontierOf(g.room), [ids[2]]);
  });
});

Deno.test('ingest: >20 prev_events is a clean refusal — nothing stored, frontier intact', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!ing2:test' });
    const before = await g.room.tx(async (tx) => ({
      changes: (await tx.changes.after(0, 100)).length,
      frontier: await tx.extremities.frontier(
        (await tx.segments.openStay())!.id,
      ),
    }));
    const many = Array.from({ length: 21 }, (_, i) => `$p${i}`);
    const pdu = {
      type: 'm.room.message',
      room_id: g.roomId,
      sender: g.creator,
      content: { body: 'too many prevs', msgtype: 'm.text' },
      prev_events: many,
      auth_events: [],
      depth: 99,
      origin_server_ts: 2000,
      hashes: { sha256: 'x' },
      signatures: { test: { 'ed25519:test': 'x' } },
      event_id: '$whatever',
    } as Pdu;
    const err = await assertRejects(() => ingestLocal(g.room, pdu));
    assert(
      String(err).startsWith('Error: M_TOO_MANY_PREV_EVENTS'),
      String(err),
    );
    const after = await g.room.tx(async (tx) => ({
      changes: (await tx.changes.after(0, 100)).length,
      frontier: await tx.extremities.frontier(
        (await tx.segments.openStay())!.id,
      ),
      event: await tx.events.get('$whatever'),
    }));
    assertEquals(after.changes, before.changes);
    assertEquals(after.frontier, before.frontier);
    assertEquals(after.event, null);
  });
});

Deno.test('ingest: a 3-prev message keeps the full DAG and converges to one extremity', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!ing3:test' });
    // fork to three extremities over the genesis tip
    const ids: string[] = [];
    for (const [i, body] of ['C1', 'C2', 'C3'].entries()) {
      const r = await sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body, msgtype: 'm.text' },
        prev_events: [g.tipId],
        origin_server_ts: 1000 + i,
      }, g.signer);
      assertEquals(r.standing, 'accepted');
      ids.push(r.eventId);
    }
    assertEquals((await frontierOf(g.room)).length, 3);
    const heal = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'converge', msgtype: 'm.text' },
      prev_events: ids,
      origin_server_ts: 2000,
    }, g.signer);
    assertEquals(heal.standing, 'accepted');
    await g.room.tx(async (tx) => {
      assertEquals(await tx.events.prevsOf(heal.eventId), ids);
    });
    assertEquals(await frontierOf(g.room), [heal.eventId]);
  });
});

Deno.test('ingest: E4 — a soft-failed event consumes nothing; an accepted child walks the flagged chain', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!ing4:test' });
    await bobJoins(g);
    const base = (await frontierOf(g.room))[0];
    // fork: A (dev's message) and B (the ban) both on base
    const a = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'A', msgtype: 'm.text' },
      prev_events: [base],
      origin_server_ts: 2000,
    }, g.signer);
    const ban = await sendLocal(g.room, {
      type: 'm.room.member',
      sender: g.creator,
      state_key: '@bob:test',
      content: { membership: 'ban' },
      prev_events: [base],
      origin_server_ts: 2001,
    }, g.signer);
    assertEquals(ban.standing, 'accepted');
    assertEquals(
      (await frontierOf(g.room)).sort(),
      [a.eventId, ban.eventId].sort(),
    );
    // bob's message on A soft-fails (banned at the current resolved state)
    const soft = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: '@bob:test',
      content: { body: 'ban evasion', msgtype: 'm.text' },
      prev_events: [a.eventId],
      origin_server_ts: 2002,
    }, g.signer);
    assertEquals(soft.standing, 'soft_failed');
    // it is not an extremity and consumed nothing
    assertEquals(
      (await frontierOf(g.room)).sort(),
      [a.eventId, ban.eventId].sort(),
    );
    // dev's accepted message citing the soft-failed event walks back
    // through it and consumes the underlying extremity A
    const heal = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'accepted over a soft-failed prev', msgtype: 'm.text' },
      prev_events: [soft.eventId],
      origin_server_ts: 2003,
    }, g.signer);
    assertEquals(heal.standing, 'accepted');
    assertEquals(
      (await frontierOf(g.room)).sort(),
      [ban.eventId, heal.eventId].sort(),
    );
  });
});

Deno.test('ingest: E4 — a rejected event consumes nothing and never enters state', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!ing5:test' });
    await bobJoins(g);
    const tip = (await frontierOf(g.room))[0];
    // bob (PL 0) sends a state event — state-reject (state_default 50)
    const rejected = await sendLocal(g.room, {
      type: 'm.room.name',
      sender: '@bob:test',
      state_key: '',
      content: { name: 'bob has no power here' },
      prev_events: [tip],
      origin_server_ts: 3000,
    }, g.signer);
    assertEquals(rejected.standing, 'rejected');
    assertEquals(rejected.reason, 'state');
    // stored, flagged, but out of the published state and the frontier
    await g.room.tx(async (tx) => {
      assert((await tx.events.get(rejected.eventId)) !== null);
      assertEquals(
        (await tx.events.getStatus(rejected.eventId))?.standing,
        'rejected',
      );
    });
    assertEquals(await frontierOf(g.room), [tip]);
    assertEquals(await currentKey(g.room, 'm.room.name', ''), null);
    // the room still authors fine from the same extremity
    const next = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'after the rejected event', msgtype: 'm.text' },
      origin_server_ts: 3001,
    }, g.signer);
    assertEquals(next.standing, 'accepted');
    assertEquals(await frontierOf(g.room), [next.eventId]);
  });
});

Deno.test('ingest: publication on ingest; a soft-fail never moves the current state', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!ing6:test' });
    await bobJoins(g);
    const base = (await frontierOf(g.room))[0];
    const ban = await sendLocal(g.room, {
      type: 'm.room.member',
      sender: g.creator,
      state_key: '@bob:test',
      content: { membership: 'ban' },
      prev_events: [base],
      origin_server_ts: 2000,
    }, g.signer);
    assertEquals(ban.standing, 'accepted');
    // published without any re-resolution: bob's membership is ban
    assertEquals(
      await currentKey(g.room, 'm.room.member', '@bob:test'),
      ban.eventId,
    );
    const groups = await g.room.tx(async (tx) => {
      const stay = (await tx.segments.openStay())!;
      return {
        base: ((await tx.state.eventStateAfter(base))!).group,
        ban: ((await tx.state.eventStateAfter(ban.eventId))!).group,
        current: (await tx.state.current(stay.id))!,
      };
    });
    assertEquals(groups.current, groups.ban);
    // bob's soft-failed message (citing the pre-ban tip)
    const soft = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: '@bob:test',
      content: { body: 'ban evasion attempt', msgtype: 'm.text' },
      prev_events: [base],
      origin_server_ts: 2001,
    }, g.signer);
    assertEquals(soft.standing, 'soft_failed');
    await g.room.tx(async (tx) => {
      const stay = (await tx.segments.openStay())!;
      // the current pointer did not move across the soft-fail
      assertEquals(await tx.state.current(stay.id), groups.current);
      // the soft-failed message's own after-map is the pass-through map
      const softAfter = (await tx.state.eventStateAfter(soft.eventId))!;
      assertEquals(softAfter.group, groups.base);
    });
  });
});

Deno.test('ingest: fork/heal — concurrent state edits resolve to the spec winner; one extremity', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!ing7:test' });
    const base = (await frontierOf(g.room))[0];
    const cats = await sendLocal(g.room, {
      type: 'm.room.topic',
      sender: g.creator,
      state_key: '',
      content: { topic: 'cats' },
      prev_events: [base],
      origin_server_ts: 1000,
    }, g.signer);
    const dogs = await sendLocal(g.room, {
      type: 'm.room.topic',
      sender: g.creator,
      state_key: '',
      content: { topic: 'dogs' },
      prev_events: [base],
      origin_server_ts: 2000,
    }, g.signer);
    assertEquals(
      (await frontierOf(g.room)).sort(),
      [cats.eventId, dogs.eventId].sort(),
    );
    // the heal: default prevs are the two extremities, deterministically
    // sorted
    const heal = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'heal', msgtype: 'm.text' },
      origin_server_ts: 3000,
    }, g.signer);
    assertEquals(heal.standing, 'accepted');
    const healPdu = JSON.parse(heal.event.pdu) as Pdu;
    assertEquals(healPdu.prev_events, [cats.eventId, dogs.eventId].sort());
    assertEquals(await frontierOf(g.room), [heal.eventId]);
    // the S4 orderings pick the winner: equal power, ts ascending, the
    // later edit applies last and wins the key
    assertEquals(await currentKey(g.room, 'm.room.topic', ''), dogs.eventId);
  });
});

Deno.test('ingest: fork/heal — uncontested message heal converges', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!ing8:test' });
    const base = (await frontierOf(g.room))[0];
    const m1 = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'side-a', msgtype: 'm.text' },
      prev_events: [base],
      origin_server_ts: 1000,
    }, g.signer);
    const m2 = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'side-b', msgtype: 'm.text' },
      prev_events: [base],
      origin_server_ts: 2000,
    }, g.signer);
    const heal = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'heal', msgtype: 'm.text' },
      prev_events: [m1.eventId, m2.eventId],
      origin_server_ts: 3000,
    }, g.signer);
    assertEquals(heal.standing, 'accepted');
    assertEquals(await frontierOf(g.room), [heal.eventId]);
  });
});

Deno.test('ingest: 8 parallel sends chain on the live tip — 8 distinct events, one extremity', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!ing9:test' });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        sendLocal(g.room, {
          type: 'm.room.message',
          sender: g.creator,
          content: { body: `burst ${i}`, msgtype: 'm.text' },
          origin_server_ts: 1000 + i,
        }, g.signer)),
    );
    const ids = new Set(results.map((r) => r.eventId));
    assertEquals(ids.size, 8);
    for (const r of results) assertEquals(r.standing, 'accepted');
    assertEquals((await frontierOf(g.room)).length, 1);
    // all eight landed on one chain: 13 positions for 13 events
    await g.room.tx(async (tx) => {
      const stay = (await tx.segments.openStay())!;
      const page = await tx.segments.positionsPage(stay.id, 0, 'f', 20);
      assertEquals(page.length, 13);
    });
  });
});

Deno.test('ingest: a single-prev linear ingest performs no state resolution', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!ing10:test' });
    const before = resolutionProbe.resolutions;
    const r = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'linear', msgtype: 'm.text' },
      origin_server_ts: 1000,
    }, g.signer);
    assertEquals(r.standing, 'accepted');
    assertEquals(resolutionProbe.resolutions, before);
  });
});

Deno.test('ingest: a throw mid-transaction rolls the whole ingest back (G11)', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!ing11:test' });
    const good = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'good', msgtype: 'm.text' },
      origin_server_ts: 1000,
    }, g.signer);
    // a tampered event that reaches the write phase and fails there: a
    // non-string state_key throws inside events.insert
    const bad = JSON.parse(good.event.pdu) as Pdu;
    bad.prev_events = [good.eventId];
    bad.depth = 99;
    bad.origin_server_ts = 1001;
    bad.content = { body: 'bad', msgtype: 'm.text' };
    (bad as unknown as Record<string, unknown>).state_key = 42;
    await resign(bad, g.signer);
    const before = await g.room.tx(async (tx) => {
      const stay = (await tx.segments.openStay())!;
      return {
        changes: (await tx.changes.after(0, 100)).length,
        frontier: await tx.extremities.frontier(stay.id),
        group: await tx.state.current(stay.id),
      };
    });
    let good2Id = '';
    await assertRejects(() =>
      withRoomLock(g.roomId, () =>
        g.room.tx(async (tx) => {
          const good2 = await buildInTx(tx, g.roomId, {
            type: 'm.room.message',
            sender: g.creator,
            content: { body: 'good2', msgtype: 'm.text' },
            origin_server_ts: 1002,
          }, g.signer);
          good2Id = good2.event_id!;
          await ingestInTx(tx, g.roomId, good2);
          await ingestInTx(tx, g.roomId, bad);
        }))
    );
    const after = await g.room.tx(async (tx) => {
      const stay = (await tx.segments.openStay())!;
      return {
        changes: (await tx.changes.after(0, 100)).length,
        frontier: await tx.extremities.frontier(stay.id),
        group: await tx.state.current(stay.id),
        good2: await tx.events.get(good2Id),
        bad: await tx.events.get(String(bad.event_id)),
      };
    });
    // both events' writes rolled back with the failed transaction
    assertEquals(after.good2, null);
    assertEquals(after.bad, null);
    assertEquals(after.changes, before.changes);
    assertEquals(after.frontier, before.frontier);
    assertEquals(after.group, before.group);
  });
});

Deno.test('ingest: redelivery returns the original receipt — no second write', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!ing12:test' });
    const r = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'once', msgtype: 'm.text' },
      origin_server_ts: 1000,
    }, g.signer);
    assertEquals(r.standing, 'accepted');
    const countBefore = await g.room.tx(async (tx) =>
      (await tx.changes.after(0, 100)).length
    );
    const again = await ingestLocal(g.room, JSON.parse(r.event.pdu) as Pdu);
    assertEquals(again.eventId, r.eventId);
    assertEquals(again.standing, 'accepted');
    await g.room.tx(async (tx) => {
      assertEquals((await tx.changes.after(0, 100)).length, countBefore);
    });
  });
});

Deno.test('ingest: delivery intent follows joined remote members (state after the event)', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, {
      roomId: '!ing13:test',
      joinRule: 'public',
    });
    const join = await sendLocal(g.room, {
      type: 'm.room.member',
      sender: '@bob:remote.test',
      state_key: '@bob:remote.test',
      content: { membership: 'join' },
      origin_server_ts: 1000,
    }, g.signer);
    assertEquals(join.standing, 'accepted');
    const deliveries = async () =>
      await g.room.tx(async (tx) =>
        (await tx.changes.after(0, 100)).filter((c) => c.kind === 'delivery')
      );
    // bob's own join delivers to his server (he is joined in its after-state)
    const forJoin = (await deliveries()).find((c) => c.event === join.eventId);
    assertEquals(JSON.parse(forJoin!.data).destinations, ['remote.test']);
    // a message while bob is joined also delivers there
    const msg = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'hello remote', msgtype: 'm.text' },
      origin_server_ts: 1001,
    }, g.signer);
    const forMsg = (await deliveries()).find((c) => c.event === msg.eventId);
    assertEquals(JSON.parse(forMsg!.data).destinations, ['remote.test']);
    // bob leaves; his leave and later messages no longer deliver to his
    // server (the plan's after-the-event formula; the old-code difference
    // is recorded in notes.md)
    const leave = await sendLocal(g.room, {
      type: 'm.room.member',
      sender: '@bob:remote.test',
      state_key: '@bob:remote.test',
      content: { membership: 'leave' },
      origin_server_ts: 1002,
    }, g.signer);
    const forLeave = (await deliveries()).find((c) =>
      c.event === leave.eventId
    );
    assertEquals(JSON.parse(forLeave!.data).destinations, []);
    const later = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'after the leave', msgtype: 'm.text' },
      origin_server_ts: 1003,
    }, g.signer);
    const forLater = (await deliveries()).find((c) =>
      c.event === later.eventId
    );
    assertEquals(JSON.parse(forLater!.data).destinations, []);
  });
});

Deno.test('ingest: the last joined local member leaving closes the stay (I15)', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!ing14:test' });
    await bobJoins(g, '@bob:remote.test', 100);
    // bob's leave does not close the stay (dev is still joined)
    const leave = await sendLocal(g.room, {
      type: 'm.room.member',
      sender: '@bob:remote.test',
      state_key: '@bob:remote.test',
      content: { membership: 'leave' },
      origin_server_ts: 101,
    }, g.signer);
    assertEquals(leave.standing, 'accepted');
    assert((await g.room.tx((tx) => tx.segments.openStay())) !== null);
    // dev's own leave closes it (he is the last joined local member)
    const devLeave = await sendLocal(g.room, {
      type: 'm.room.member',
      sender: g.creator,
      state_key: g.creator,
      content: { membership: 'leave' },
      origin_server_ts: 102,
    }, g.signer);
    assertEquals(devLeave.standing, 'accepted');
    await g.room.tx(async (tx) => {
      assertEquals(await tx.segments.openStay(), null);
      // the archived stay keeps its extremities (R9)
      const stays = await tx.segments.list();
      assertEquals(stays.length, 1);
      assertEquals(stays[0].status, 'closed');
      assert((await tx.extremities.frontier(stays[0].id)).length > 0);
    });
    // later local ingest on the closed room refuses
    const err = await assertRejects(() =>
      sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body: 'too late', msgtype: 'm.text' },
      }, g.signer)
    );
    assert(String(err).includes('E_ROOM_ARCHIVED'), String(err));
  });
});

Deno.test('ingest: a soft-failed state event carries its own key in its after-map', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!ing15:test' });
    await bobJoins(g);
    // bob holds PL 50 in the before-state, so his state event passes the
    // before-state auth (state_default 50) and only the current-state
    // (ban) check fails
    const pl = await sendLocal(g.room, {
      type: 'm.room.power_levels',
      sender: g.creator,
      state_key: '',
      content: {
        ...PL_DEFAULTS(g.creator),
        users: { [g.creator]: 100, '@bob:test': 50 },
      },
      origin_server_ts: 1500,
    }, g.signer);
    assertEquals(pl.standing, 'accepted');
    const base = (await frontierOf(g.room))[0];
    const ban = await sendLocal(g.room, {
      type: 'm.room.member',
      sender: g.creator,
      state_key: '@bob:test',
      content: { membership: 'ban' },
      prev_events: [base],
      origin_server_ts: 2000,
    }, g.signer);
    assertEquals(ban.standing, 'accepted');
    // bob's topic citing the pre-ban base soft-fails
    const soft = await sendLocal(g.room, {
      type: 'm.room.topic',
      sender: '@bob:test',
      state_key: '',
      content: { topic: 'ban evasion topic' },
      prev_events: [base],
      origin_server_ts: 2001,
    }, g.signer);
    assertEquals(soft.standing, 'soft_failed');
    await g.room.tx(async (tx) => {
      const after = (await tx.state.eventStateAfter(soft.eventId))!;
      // its own after-map includes its own topic key (requirements §1.1
      // row 2) even though it is not the published state
      assertEquals(
        await tx.state.groupKey(after.group, 'm.room.topic', ''),
        soft.eventId,
      );
      // ... and the published state has no topic at all
      const stay = (await tx.segments.openStay())!;
      const current = (await tx.state.current(stay.id))!;
      assertEquals(await tx.state.groupKey(current, 'm.room.topic', ''), null);
    });
  });
});

Deno.test('ingest: a depth mismatch is a stored auth-reject', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!ing16:test' });
    const good = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'depth probe', msgtype: 'm.text' },
      origin_server_ts: 1000,
    }, g.signer);
    const bad = JSON.parse(good.event.pdu) as Pdu;
    bad.prev_events = [good.eventId];
    bad.depth = 99; // computed would be good.depth + 1
    bad.origin_server_ts = 1001;
    bad.content = { body: 'wrong depth', msgtype: 'm.text' };
    delete (bad as unknown as Record<string, unknown>).state_key;
    await resign(bad, g.signer);
    const r = await ingestLocal(g.room, bad);
    assertEquals(r.standing, 'rejected');
    assertEquals(r.reason, 'auth');
    // stored but never published, never an extremity
    assertEquals(await frontierOf(g.room), [good.eventId]);
  });
});
