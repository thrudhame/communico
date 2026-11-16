import { assert, assertEquals } from '@std/assert';
import type { Pdu } from '#engine/pdu.ts';
import { roomSchema } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { openStore } from '#engine/store/index.ts';
import { genesis } from './fixtures/genesis.ts';

for (const version of ['11', '12']) {
  Deno.test(`local parents: v${version} selects from a large frontier without losing DAG truth`, async () => {
    const dir = await Deno.makeTempDir();
    const store = await openStore({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { room: roomSchema } });
    try {
      const g = await genesis(store, { version, roomId: '!parents:test' });
      const heads = new Map<string, number>();
      const retained: string[] = [];
      for (let index = 0; index < 24; index++) {
        const result = await sendLocal(g.room, {
          type: 'm.room.message',
          sender: g.creator,
          content: { msgtype: 'm.text', body: `fork ${index}` },
          prev_events: [g.tipId],
          origin_server_ts: 1000 + index,
        }, g.signer);
        assertEquals(result.standing, 'accepted');
        heads.set(result.eventId, Number(JSON.parse(result.event.pdu).depth));
        retained.push(result.eventId);
      }
      for (const [index, id] of retained.slice(0, 3).entries()) {
        const result = await sendLocal(g.room, {
          type: 'm.room.message',
          sender: g.creator,
          content: { msgtype: 'm.text', body: `deeper fork ${index}` },
          prev_events: [id],
          origin_server_ts: 1100 + index,
        }, g.signer);
        assertEquals(result.standing, 'accepted');
        heads.delete(id);
        heads.set(result.eventId, Number(JSON.parse(result.event.pdu).depth));
        retained.push(result.eventId);
      }
      for (const [pass, count] of [24, 15, 6].entries()) {
        const before = await g.room.tx(async (tx) =>
          await tx.extremities.frontier((await tx.segments.openStay())!.id)
        );
        assertEquals(before.length, count);
        const selected = [...heads].sort((a, b) =>
          b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
        ).slice(0, 10).map(([id]) => id).sort();
        const result = await sendLocal(g.room, {
          type: pass === 0 ? 'm.room.name' : 'm.room.message',
          ...(pass === 0 ? { state_key: '' } : {}),
          sender: g.creator,
          content: pass === 0
            ? { name: 'large frontier remains writable' }
            : { msgtype: 'm.text', body: `merge ${pass}` },
          origin_server_ts: 2000 + pass,
        }, g.signer);
        assertEquals(result.standing, 'accepted');
        const pdu = JSON.parse(result.event.pdu) as Pdu;
        assertEquals(pdu.prev_events, selected);
        assertEquals(
          pdu.depth,
          Math.max(...selected.map((id) => heads.get(id)!)) + 1,
        );
        for (const id of selected) heads.delete(id);
        heads.set(result.eventId, Number(pdu.depth));
        const after = await g.room.tx(async (tx) =>
          await tx.extremities.frontier((await tx.segments.openStay())!.id)
        );
        assertEquals(after, [...heads.keys()].sort());
      }
      assertEquals(heads.size, 1);
      await g.room.tx(async (tx) => {
        for (const id of retained) {
          assert(await tx.events.get(id));
          const status = await tx.events.getStatus(id);
          assertEquals(status?.standing, 'accepted');
          assertEquals(status?.grounding, 'grounded');
        }
      });
    } finally {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}
