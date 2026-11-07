// tests/room-policy.test.ts — the old policy.test.ts's engine-observable
// contracts: a ts=2^53 seize is refused (the canonical int range), a
// non-member write is state-rejected and stays out of state, and
// concurrent power-level edits resolve deterministically — the S4
// orderings pick the winner, never a latest-wins guess. The genesis
// sequence restore lives in room-create.test.ts; the forged-adoption
// re-resolution oracle (old adopt.ts) is not a 3b deliverable (notes.md).
import { assert, assertEquals, assertRejects } from '@std/assert';
import { roomSchema } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { openStore } from '#engine/store/index.ts';
import { type Genesis, genesis } from './fixtures/genesis.ts';

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

async function withGenesis(
  opts: { joinRule?: string; roomId?: string },
  fn: (g: Genesis) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(config(dir), {
    schemas: { room: roomSchema },
  });
  try {
    await fn(await genesis(store, opts));
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function frontierOf(g: Genesis): Promise<string[]> {
  return await g.room.tx(async (tx) => {
    const stay = await tx.segments.openStay();
    if (stay === null) return [];
    return await tx.extremities.frontier(stay.id);
  });
}

// A member forging ts=2^53 is refused (the canonical int range) — the
// seizure that owned any state key forever under latest-wins.
Deno.test('policy: ts=2^53 seize is refused, nothing lands', async () => {
  await withGenesis({ roomId: '!pol1:test' }, async (g) => {
    const prev = (await frontierOf(g))[0];
    const before = await g.room.tx(async (tx) =>
      (await tx.changes.after(0, 100)).length
    );
    const err = await assertRejects(() =>
      sendLocal(g.room, {
        type: 'm.room.topic',
        sender: g.creator,
        state_key: '',
        content: { topic: 'seized' },
        prev_events: [prev],
        origin_server_ts: 2 ** 53,
      }, g.signer)
    );
    assert(
      String(err).includes('M_BAD_EVENT') ||
        String(err).includes('out-of-range'),
      String(err),
    );
    // nothing landed: the extremity is still the pre-seize tip and no
    // change was recorded
    assertEquals(await frontierOf(g), [prev]);
    await g.room.tx(async (tx) => {
      assertEquals((await tx.changes.after(0, 100)).length, before);
    });
  });
});

// A non-member's write is state-rejected (rule 5 — sender not joined) and
// stays out of state.
Deno.test('policy: non-member write is state-rejected', async () => {
  await withGenesis({ roomId: '!pol2:test' }, async (g) => {
    const r = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: '@mallory:test',
      content: { body: 'intruder', msgtype: 'm.text' },
      origin_server_ts: 1000,
    }, g.signer);
    assertEquals(r.standing, 'rejected');
    assertEquals(r.reason, 'auth');
    assert(r.rule !== null, 'a rule must be recorded');
    // in the DAG (stored, flagged) but never in the published state and
    // never an extremity
    await g.room.tx(async (tx) => {
      assert((await tx.events.get(r.eventId)) !== null);
      assertEquals(
        (await tx.events.getStatus(r.eventId))?.standing,
        'rejected',
      );
      const stay = (await tx.segments.openStay())!;
      const current = (await tx.state.current(stay.id))!;
      for (const id of (await tx.state.groupMap(current)).values()) {
        assert(id !== r.eventId, 'rejected event must never enter state');
      }
      assertEquals(await tx.extremities.frontier(stay.id), [g.tipId]);
    });
  });
});

// Concurrent power-level edits RESOLVE: equal power ties the
// reverse-topological ordering, the earlier origin_server_ts orders first
// and the later edit applies last and wins the key — a specified
// tie-break, not a latest-wins guess. The heal converges to one extremity.
Deno.test('policy: concurrent PL edits resolve; the heal succeeds; one extremity', async () => {
  await withGenesis({ roomId: '!pol3:test' }, async (g) => {
    const base = (await frontierOf(g))[0];
    const pla = await sendLocal(g.room, {
      type: 'm.room.power_levels',
      sender: g.creator,
      state_key: '',
      content: { users: { [g.creator]: 100 }, state_default: 0 },
      prev_events: [base],
      origin_server_ts: 1000,
    }, g.signer);
    assertEquals(pla.standing, 'accepted');
    const plb = await sendLocal(g.room, {
      type: 'm.room.power_levels',
      sender: g.creator,
      state_key: '',
      content: { users: { [g.creator]: 100 }, state_default: 100 },
      prev_events: [base],
      origin_server_ts: 9999999999999,
    }, g.signer);
    assertEquals(plb.standing, 'accepted');
    assertEquals(
      (await frontierOf(g)).sort(),
      [pla.eventId, plb.eventId].sort(),
    );
    const heal = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'heal', msgtype: 'm.text' },
      origin_server_ts: 3000,
    }, g.signer);
    assertEquals(heal.standing, 'accepted');
    assertEquals(await frontierOf(g), [heal.eventId]);
    // the resolved winner is the spec-determined one: PLB (later ts,
    // applied last) — state_default 100
    await g.room.tx(async (tx) => {
      const stay = (await tx.segments.openStay())!;
      const current = (await tx.state.current(stay.id))!;
      assertEquals(
        await tx.state.groupKey(current, 'm.room.power_levels', ''),
        plb.eventId,
      );
    });
  });
});
