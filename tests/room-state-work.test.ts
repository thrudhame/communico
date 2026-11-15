import { assert, assertEquals } from '@std/assert';
import { roomSchema } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { Turso } from '#engine/store/ffi.ts';
import { openStore } from '#engine/store/index.ts';
import { genesis } from './fixtures/genesis.ts';

Deno.test('state work: repeated frontier groups do not repeat immutable state reads', async () => {
  const original = Turso.prototype.query;
  let observing = false;
  let reads = 0;
  Turso.prototype.query = function (connection, sql, values) {
    if (observing && /FROM state_(groups|entries)/.test(sql)) reads++;
    return original.call(this, connection, sql, values);
  };
  const results: { heads: number; reads: number; ms: number }[] = [];
  try {
    for (const heads of [1, 24]) {
      const dir = await Deno.makeTempDir();
      const store = await openStore({
        dir,
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
        maxopenfiles: 8,
        idleseconds: 300,
      }, { schemas: { room: roomSchema } });
      try {
        const g = await genesis(store, { roomId: '!state-work:test' });
        const retained: string[] = [];
        for (let index = 0; index < heads; index++) {
          const result = await sendLocal(g.room, {
            type: 'm.room.message',
            sender: g.creator,
            content: { msgtype: 'm.text', body: `fork ${index}` },
            prev_events: [g.tipId],
            origin_server_ts: 1000 + index,
          }, g.signer);
          assertEquals(result.standing, 'accepted');
          retained.push(result.eventId);
        }
        const before = await g.room.tx(async (tx) => {
          const stay = (await tx.segments.openStay())!;
          const ids = await tx.extremities.frontier(stay.id);
          const groups = await Promise.all(
            ids.map((id) => tx.state.eventStateAfter(id)),
          );
          assertEquals(new Set(groups.map((group) => group!.group)).size, 1);
          return await tx.state.groupMap((await tx.state.current(stay.id))!);
        });
        reads = 0;
        observing = true;
        const started = performance.now();
        const incoming = await sendLocal(g.room, {
          type: 'm.room.message',
          sender: g.creator,
          content: { msgtype: 'm.text', body: 'another branch' },
          prev_events: [g.tipId],
          origin_server_ts: 2000,
        }, g.signer);
        results.push({ heads, reads, ms: performance.now() - started });
        observing = false;
        assertEquals(incoming.standing, 'accepted');
        await g.room.tx(async (tx) => {
          const stay = (await tx.segments.openStay())!;
          const frontier = await tx.extremities.frontier(stay.id);
          assertEquals(frontier.length, heads + 1);
          for (const id of retained) assert(frontier.includes(id));
          assertEquals(
            await tx.state.groupMap((await tx.state.current(stay.id))!),
            before,
          );
        });
      } finally {
        observing = false;
        await store.close();
        await Deno.remove(dir, { recursive: true });
      }
    }
    console.log(JSON.stringify({ state_read_work: results }));
    assert(
      results[1].reads <= results[0].reads,
      'same immutable state must not be hydrated once per frontier event',
    );
  } finally {
    Turso.prototype.query = original;
  }
});
