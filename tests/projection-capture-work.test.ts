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
    const duplicateMaxima: number[] = [];
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
      const originalBegin = Turso.prototype.begin;
      const epochs = new Map<number, number>();
      const reads = new Map<string, number>();
      Turso.prototype.begin = function (connection, mode) {
        epochs.set(connection, (epochs.get(connection) ?? 0) + 1);
        return originalBegin.call(this, connection, mode);
      };
      let stateReads = 0;
      const groupReads = new Map<number, number>();
      Turso.prototype.query = function (...args) {
        if (args[1].endsWith('FROM events WHERE id = ?')) {
          const key = String(args[0]) + ':' + String(epochs.get(args[0])) +
            ':' + String(args[2]?.[0]);
          reads.set(key, (reads.get(key) ?? 0) + 1);
        }
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
        Turso.prototype.begin = originalBegin;
      }
      reconstructedGroups = [...groupReads.values()];
      const maximum = Math.max(0, ...reads.values());
      duplicateMaxima.push(maximum);
      console.log(JSON.stringify({
        messages: bodies.length,
        pdu_native_reads: [...reads.values()].reduce((a, b) => a + b, 0),
        distinct_attempt_pdu_pairs: reads.size,
        max_reads_for_same_pdu_in_one_attempt: maximum,
      }));
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
    assertEquals(
      Math.max(...duplicateMaxima),
      1,
      'one projection capture attempt must hydrate each immutable PDU once',
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
