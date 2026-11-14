import { assertEquals, assertRejects } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import { buildInTx, finalizeBuilt } from '#engine/room/build.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import {
  afterLocalCommit,
  ingestInTx,
  ingestLocal,
  redactEvent,
  resumeWaits,
} from '#engine/room/ingest.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import { Conn } from '#engine/store/db.ts';
import { openStore } from '#engine/store/index.ts';
import { genesis } from './fixtures/genesis.ts';

Deno.test('wait recovery reads only dependencies affected by the arriving event', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    const g = await genesis(store, { roomId: '!wait-work:test' });
    const unrelated = new Set(
      Array.from({ length: 64 }, (_, i) => '$unrelated-' + i),
    );
    await g.room.tx(async (tx) => {
      for (let i = 0; i < 64; i++) {
        const id = '$unrelated-' + i, missing = '$missing-' + i;
        await tx.events.insert(
          id,
          canonicalJson({
            type: 'm.room.message',
            room_id: g.room.id,
            sender: g.creator,
            depth: 5,
            origin_server_ts: 1000,
            content: { body: 'unresolved' },
            prev_events: [missing],
            auth_events: [],
          }),
        );
        await tx.events.setStatus(id, {
          standing: 'rejected',
          grounding: 'pending',
          origin: 'remote.test',
          received_ts: 1000,
        });
        await tx.waits.add({
          missing,
          waiting: id,
          kind: 'prev',
          since: 1000,
          expires: null,
          state: 'pending',
        });
      }
    });
    const target = await g.room.tx((tx) =>
      buildInTx(tx, g.room.id, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body: 'arrives later' },
      }, g.signer)
    );
    const redaction = await redactEvent(
      g.room,
      g.creator,
      target.event_id!,
      g.signer,
    );
    await g.room.tx((tx) =>
      ingestInTx(tx, g.room.id, target, { self: g.signer.serverName })
    );
    const query = Conn.prototype.query;
    let unrelatedReads = 0;
    Conn.prototype.query = function (sql, values) {
      if (
        values?.some((value) =>
          typeof value === 'string' && unrelated.has(value)
        )
      ) unrelatedReads++;
      return query.call(this, sql, values);
    };
    try {
      await afterLocalCommit(g.room, target.event_id!, g.signer.serverName);
    } finally {
      Conn.prototype.query = query;
    }
    assertEquals(await g.room.tx((tx) => tx.waits.of(redaction.eventId)), []);
    const changes = await g.room.tx((tx) => tx.changes.after(0, 200));
    assertEquals(
      changes.filter((c) => c.kind === 'redaction').map((c) => c.event),
      [redaction.eventId],
    );
    assertEquals(
      unrelatedReads,
      0,
      'unrelated unresolved history must not become foreground recovery work',
    );
    assertEquals(
      (await g.room.tx((tx) => tx.waits.for('$missing-0'))).length,
      1,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

for (const recovery of ['arrival', 'startup']) {
  Deno.test(`wait recovery follows grounded descendants after failure via ${recovery}`, async () => {
    const dir = await Deno.makeTempDir();
    let store = await openStore({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { room: roomSchema } });
    try {
      const g = await genesis(store, { roomId: '!wait-chain:test' });
      const first = await g.room.tx((tx) =>
        buildInTx(tx, g.room.id, {
          type: 'm.room.message',
          sender: g.creator,
          content: { body: 'first parent' },
        }, g.signer)
      );
      const other = await g.room.tx((tx) =>
        buildInTx(tx, g.room.id, {
          type: 'm.room.message',
          sender: g.creator,
          content: { body: 'other parent' },
        }, g.signer)
      );
      const { event_id: _, ...template } = first;
      void _;
      const child = await finalizeBuilt(
        {
          ...template,
          content: { body: 'both parents required' },
          prev_events: [first.event_id!, other.event_id!],
          depth: Number(first.depth) + 1,
        },
        getRulebook('11'),
        g.signer,
      );
      const descendant = await finalizeBuilt(
        {
          ...template,
          content: { body: 'descendant' },
          prev_events: [child.event_id!],
          depth: Number(child.depth) + 1,
        },
        getRulebook('11'),
        g.signer,
      );
      for (const pdu of [descendant, child]) {
        const result = await g.room.tx((tx) =>
          ingestInTx(tx, g.room.id, pdu, {
            remote: {
              origin: g.signer.serverName,
              self: g.signer.serverName,
              oversized: false,
              ungroundedMs: 3600000,
            },
          })
        );
        assertEquals(result.grounding, 'pending');
      }
      await ingestLocal(g.room, first, g.signer.serverName);
      assertEquals(
        (await g.room.tx((tx) => tx.events.getStatus(child.event_id!)))
          ?.grounding,
        'pending',
      );
      const transaction = g.room.tx;
      let failNext = false, injected = false;
      g.room.tx = async (fn) => {
        if (failNext) {
          failNext = false;
          throw new Error('injected recovery failure');
        }
        const result = await transaction(fn);
        if (
          !injected && result && typeof result === 'object' &&
          'kind' in result && result.kind === 'prev' && 'eventId' in result &&
          result.eventId === descendant.event_id
        ) {
          injected = true;
          failNext = true;
        }
        return result;
      };
      try {
        await assertRejects(
          () => ingestLocal(g.room, other, g.signer.serverName),
          Error,
          'injected recovery failure',
        );
      } finally {
        g.room.tx = transaction;
      }
      assertEquals(
        (await g.room.tx((tx) => tx.events.getStatus(child.event_id!)))
          ?.grounding,
        'grounded',
      );
      assertEquals(await g.room.tx((tx) => tx.waits.of(child.event_id!)), []);
      if (recovery === 'startup') {
        // No arriving ancestor, and a complete native database lifetime later.
        await store.close();
        store = await openStore({
          dir,
          library: './.native/libturso_ffi.so',
          checkpointlogbytes: 65536,
          maxopenfiles: 8,
          idleseconds: 300,
        }, { schemas: { room: roomSchema } });
        g.room = await openRoom(store, g.room.id);
        await resumeWaits(g.room, { self: g.signer.serverName }, []);
        assertEquals(
          (await g.room.tx((tx) => tx.events.getStatus(descendant.event_id!)))
            ?.grounding,
          'grounded',
        );
      }
      // The original parent is already committed. Its ordinary idempotent retry
      // must revisit retained dependency work instead of falsely acknowledging it.
      await ingestLocal(g.room, other, g.signer.serverName);
      for (const pdu of [child, descendant]) {
        assertEquals(
          (await g.room.tx((tx) => tx.events.getStatus(pdu.event_id!)))
            ?.grounding,
          'grounded',
        );
        assertEquals(await g.room.tx((tx) => tx.waits.of(pdu.event_id!)), []);
        const changes = await g.room.tx((tx) => tx.changes.after(0, 200));
        assertEquals(
          changes.filter((change) =>
            change.event === pdu.event_id && change.kind === 'transition'
          ).length,
          1,
        );
      }
    } finally {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}
