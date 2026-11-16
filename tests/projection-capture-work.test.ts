import { assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { Turso } from '#engine/store/ffi.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { project } from '#engine/server/project.ts';
import { bobJoins, genesis } from '#tests/fixtures/genesis.ts';

Deno.test('projection capture: unchanged state is reconstructed once per room page, not per event', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 16,
    idleseconds: 300,
  }, {
    schemas: { room: roomSchema, server: serverSchema, tenant: tenantSchema },
  });
  try {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('dev', 'Dev');
      await tx.users.insert('bob', 'Bob');
    });
    const g = await genesis(store, { roomId: '!capture-page-state:test' });
    await bobJoins(g);
    await project(store, g.roomId);
    const sent: string[] = [];
    let reconstructedGroups: number[] = [];
    const measure = async (bodies: string[], state = false) => {
      for (const body of bodies) {
        const result = await sendLocal(g.room, {
          type: state ? 'm.room.name' : 'm.room.message',
          state_key: state ? '' : undefined,
          sender: g.creator,
          content: state ? { name: body } : { body, msgtype: 'm.text' },
        }, g.signer);
        sent.push(result.eventId);
      }
      const original = Turso.prototype.query;
      let stateReads = 0;
      const groupReads = new Map<number, number>();
      Turso.prototype.query = function (...args) {
        if (/\bFROM state_(?:groups|entries)\b/i.test(args[1])) stateReads++;
        if (args[1] === 'SELECT id, parent FROM state_groups WHERE id = ?') {
          const group = Number(args[2]?.[0]);
          groupReads.set(group, (groupReads.get(group) ?? 0) + 1);
        }
        return original.apply(this, args);
      };
      try {
        await project(store, g.roomId);
      } finally {
        Turso.prototype.query = original;
      }
      reconstructedGroups = [...groupReads.values()];
      return stateReads;
    };
    const single = await measure(['single']);
    const page = await measure(['one', 'two', 'three', 'four', 'five']);
    console.log(
      JSON.stringify({ single_state_reads: single, page_state_reads: page }),
    );
    assertEquals(
      single > 0,
      true,
      'the measurement must exercise state reconstruction',
    );
    assertEquals(
      page,
      single,
      'unchanged publication state was rebuilt for each event',
    );
    const server = await store.server();
    assertEquals(
      (await server.query('SELECT event FROM feed WHERE room=? ORDER BY seq', [
        g.roomId,
      ]))
        .filter((row) => sent.includes(String(row.event))).map((row) =>
          row.event
        ),
      sent,
    );
    assertEquals(
      (await server.query('SELECT event FROM push_evaluations WHERE user=?', [
        '@bob:test',
      ]))
        .filter((row) => sent.includes(String(row.event))).length,
      sent.length,
    );
    await measure(['changed publication one', 'changed publication two'], true);
    assertEquals(reconstructedGroups.length > 0, true);
    assertEquals(
      reconstructedGroups.every((reads) => reads === 1),
      true,
      'page ancestors were rebuilt across publication and push capture paths',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
