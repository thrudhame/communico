import { assert, assertEquals } from '@std/assert';
import type { InviteDeps } from '#engine/federation/invites.ts';
import { makeJoin, makeKnock, makeLeave } from '#engine/federation/joins.ts';
import type { Pdu } from '#engine/pdu.ts';
import { roomSchema } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { leave, reopen } from '#engine/room/membership.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { bobJoins, type Genesis, genesis } from './fixtures/genesis.ts';

async function withRoom(
  joinRule: string,
  fn: (store: Store, g: Genesis) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema, server: serverSchema } });
  try {
    await fn(
      store,
      await genesis(store, { roomId: '!parent-consumers:test', joinRule }),
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function fork(g: Genesis, tip: string, count: number) {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const result = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { msgtype: 'm.text', body: `retained branch ${index}` },
      prev_events: [tip],
      origin_server_ts: 1000 + index,
    }, g.signer);
    assertEquals(result.standing, 'accepted');
    ids.push(result.eventId);
  }
  return ids.sort();
}

for (const joinRule of ['public', 'knock']) {
  Deno.test(`parent consumers: ${joinRule} federation templates select without truncating the frontier`, async () => {
    await withRoom(joinRule, async (store, g) => {
      const remote = '@bob:remote.test';
      const tip = await bobJoins(g, remote);
      const ids = await fork(g, tip, 24);
      const depth = await g.room.tx(async (tx) =>
        Number((await tx.events.get(ids[0]))!.depth) + 1
      );
      const deps = {
        store,
        server: await store.server(),
        self: g.signer.serverName,
        signer: g.signer,
      } as InviteDeps;
      const templates = joinRule === 'public'
        ? [
          await makeJoin(
            g.roomId,
            '@new:remote.test',
            'remote.test',
            ['11'],
            deps,
          ),
          await makeLeave(g.roomId, remote, 'remote.test', ['11'], deps),
        ]
        : [
          await makeKnock(
            g.roomId,
            '@new:remote.test',
            'remote.test',
            ['11'],
            deps,
          ),
        ];
      for (const template of templates) {
        assertEquals(template.event.prev_events, ids.slice(0, 10));
        assertEquals(template.event.depth, depth);
      }
      assertEquals(
        await g.room.tx(async (tx) =>
          await tx.extremities.frontier((await tx.segments.openStay())!.id)
        ),
        ids,
      );
    });
  });
}

Deno.test('parent consumers: archived reopen selects parents and preserves every old head', async () => {
  await withRoom('public', async (_store, g) => {
    const ids = await fork(g, g.tipId, 40);
    await leave(g.room, g.creator, g.signer);
    const archived = await g.room.tx(async (tx) => {
      assertEquals(await tx.segments.openStay(), null);
      const stay = (await tx.segments.latestStay())!;
      return { id: stay.id, heads: await tx.extremities.frontier(stay.id) };
    });
    assertEquals(archived.heads.length, 31);
    const joined = await reopen(g.room, g.creator, g.signer, {});
    await g.room.tx(async (tx) => {
      const stay = (await tx.segments.openStay())!;
      assert(stay.id !== archived.id);
      assertEquals(await tx.extremities.frontier(archived.id), archived.heads);
      assertEquals(await tx.extremities.frontier(stay.id), [joined.eventId]);
      const row = (await tx.events.get(joined.eventId))!;
      const pdu = JSON.parse(row.pdu) as Pdu;
      assertEquals(pdu.prev_events?.length, 10);
      assert(pdu.prev_events?.every((id) => archived.heads.includes(id)));
      assertEquals(
        (await tx.events.getStatus(joined.eventId))?.standing,
        'accepted',
      );
      for (const id of ids) assert(await tx.events.get(id));
    });
  });
});
