// Typed handles publish only the successful attempt's effects.
import { assertEquals, assertRejects } from '@std/assert';
import { buildInTx, resolutionProbe } from '#engine/room/build.ts';
import { ingestInTx } from '#engine/room/ingest.ts';
import { roomSchema } from '#engine/room/index.ts';
import { StoreError } from '#engine/store/ffi.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { onTenantStream } from '#engine/tenant/streams.ts';
import { genesis } from './fixtures/genesis.ts';

const conflict = () => new StoreError(517, 'snapshot conflict', 'BusySnapshot');

async function withStore(fn: (store: Store) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 2,
    idleseconds: 300,
  }, { schemas: { room: roomSchema, tenant: tenantSchema } });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('transaction retries: tenant notifications reflect only the committed attempt', async () => {
  await withStore(async (store) => {
    const tenant = await openTenant(store, 'tenant.test', { create: true });
    let notifications = 0, attempts = 0;
    const dispose = onTenantStream((owner, name) => {
      if (owner === store && name === tenant.serverName) notifications++;
    });
    try {
      await tenant.tx(async (tx) => {
        if (++attempts === 1) {
          await tx.counters.nextStream();
          throw conflict();
        }
        // A fresh snapshot can legitimately decide that no write is needed.
      });
      assertEquals(attempts, 2);
      assertEquals(notifications, 0);
      attempts = 0;
      assertEquals(
        await tenant.tx(async (tx) => {
          const seq = await tx.counters.nextStream();
          if (++attempts === 1) throw conflict();
          return seq;
        }),
        1,
      );
      assertEquals(notifications, 1);
    } finally {
      dispose();
    }
    assertEquals(store.stats().poolErrors, []);
  });
});

Deno.test('transaction retries: resolution diagnostics commit once and ingest leaves input unchanged', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!retry:test' });
    const joinId = await g.room.tx(async (tx) => {
      const after = await tx.state.eventStateAfter(g.tipId);
      return await tx.state.groupKey(after!.group, 'm.room.member', g.creator);
    });
    const fork = await g.room.tx((tx) =>
      buildInTx(tx, g.roomId, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body: 'fork' },
        prev_events: [joinId!],
        origin_server_ts: 100,
      }, g.signer)
    );
    fork.unsigned = { age: 10 };
    const beforeInput = structuredClone(fork);
    let attempts = 0;
    await g.room.tx(async (tx) => {
      await ingestInTx(tx, g.roomId, fork, { self: g.signer.serverName });
      if (++attempts === 1) throw conflict();
    });
    assertEquals(attempts, 2);
    assertEquals(fork, beforeInput);
    const stored = await g.room.tx((tx) => tx.events.get(fork.event_id!));
    assertEquals(JSON.parse(stored!.pdu).unsigned, undefined);

    // The fork and the old tip both remain extremities, so building resolves.
    const before = resolutionProbe.resolutions;
    attempts = 0;
    await g.room.tx(async (tx) => {
      const pdu = await buildInTx(tx, g.roomId, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body: 'resolve' },
      }, g.signer);
      if (++attempts === 1) throw conflict();
      return pdu;
    });
    assertEquals(attempts, 2);
    assertEquals(resolutionProbe.resolutions, before + 1);
    await assertRejects(
      () =>
        g.room.tx(async (tx) => {
          await buildInTx(tx, g.roomId, {
            type: 'm.room.message',
            sender: g.creator,
            content: { body: 'abort' },
          }, g.signer);
          throw new Error('abort');
        }),
      Error,
      'abort',
    );
    assertEquals(resolutionProbe.resolutions, before + 1);
  });
});
