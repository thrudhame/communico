import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import {
  completeBatch,
  enqueueEdu,
  freezeBatch,
  frozenBatch,
  pendingEdus,
} from '#engine/server/delivery.ts';

Deno.test('E3: server v5 upgrade preserves pending work, frozen envelopes survive reopen, and retired PDUs never expire reliable EDUs', async () => {
  const dir = await Deno.makeTempDir();
  const config = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const previous = {
    version: 5,
    apply: async (db: Parameters<typeof serverSchema.apply>[0]) => {
      await serverSchema.apply(db);
      await db.exec(
        'DROP TABLE public_signing_keys; DROP TABLE device_recovery_requests; DROP TABLE device_subscriptions; DROP TABLE remote_device_keys; DROP TABLE remote_device_users;',
      );
      await db.exec(
        "DROP TABLE edu_outbox; DROP TABLE federation_batches; DELETE FROM counters WHERE name='reliable-edus'",
      );
    },
  };
  let store = await openStore(config, { schemas: { server: previous } });
  try {
    let server = await store.server();
    await server.execute(
      "INSERT INTO outbox(room,pos,destination,event,state,added_ms) VALUES('!r:test',1,'remote.test','$e','pending',123)",
    );
    await store.close();
    store = await openStore(config, { schemas: { server: serverSchema } });
    server = await store.server();
    await server.tx((tx) =>
      enqueueEdu(tx, 'tenant:one', 'remote.test', 'm.direct_to_device', {
        message_id: 'one',
      })
    );
    const envelope = {
      txnId: 'frozen-one',
      body: '{"pdus":[],"edus":[{"opaque":"one"}]}',
      rows: [{
        room: '!r:test',
        pos: 1,
        destination: 'remote.test',
        event: '$e',
        seq: 1,
        attempts: 0,
        addedMs: 123,
      }],
      sources: ['tenant:one'],
    };
    assertEquals(await freezeBatch(server, 'remote.test', envelope), true);
    await store.close();
    store = await openStore(config, { schemas: { server: serverSchema } });
    server = await store.server();
    assertEquals(await frozenBatch(server, 'remote.test'), envelope);
    await assertRejects(() =>
      server.tx(async (tx) => {
        await completeBatch(tx, 'remote.test', envelope);
        throw new Error('crash after transport success before delivery commit');
      })
    );
    assertEquals(await frozenBatch(server, 'remote.test'), envelope);
    assertEquals(
      (await server.query('SELECT state FROM edu_outbox'))[0].state,
      'pending',
    );
    await server.execute("UPDATE outbox SET state='failed'");
    assertEquals(await frozenBatch(server, 'remote.test'), null);
    assertEquals(
      (await server.query('SELECT state FROM edu_outbox'))[0].state,
      'pending',
    );
    const retry = { ...envelope, txnId: 'frozen-two', rows: [] };
    assertEquals(await freezeBatch(server, 'remote.test', retry), true);
    await server.tx((tx) => completeBatch(tx, 'remote.test', retry));
    assertEquals(await frozenBatch(server, 'remote.test'), null);
    assertEquals(
      (await server.query('SELECT state FROM edu_outbox'))[0].state,
      'sent',
    );
    assertEquals(
      (await server.query('SELECT state FROM outbox'))[0].state,
      'failed',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E3 v6 FIFO upgrade retains insertion order and exact frozen ownership across reopen', async () => {
  const dir = await Deno.makeTempDir();
  const config = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const previous = {
    version: 6,
    apply: async (db: Parameters<typeof serverSchema.apply>[0]) => {
      await serverSchema.apply(db);
      await db.exec(
        'DROP TABLE public_signing_keys; DROP TABLE device_recovery_requests; DROP TABLE device_subscriptions; DROP TABLE remote_device_keys; DROP TABLE remote_device_users;',
      );
      await db.exec(
        "DROP INDEX edu_outbox_fifo; DROP INDEX edu_outbox_completed; ALTER TABLE edu_outbox DROP COLUMN enqueue_pos; DELETE FROM counters WHERE name='reliable-edus'",
      );
    },
  };
  let store = await openStore(config, { schemas: { server: previous } });
  const frozen = {
    txnId: 'old-frozen',
    body: 'exact bytes',
    rows: [],
    sources: ['z-old'],
  };
  try {
    let server = await store.server();
    for (const source of ['z-old', 'a-new']) {
      await server.execute(
        "INSERT INTO edu_outbox VALUES(?,'remote.test','m.test',?,'pending')",
        [source, JSON.stringify({ source })],
      );
    }
    await freezeBatch(server, 'remote.test', frozen);
    await store.close();
    store = await openStore(config, { schemas: { server: serverSchema } });
    server = await store.server();
    assertEquals(await frozenBatch(server, 'remote.test'), frozen);
    await server.tx(async (tx) => {
      await enqueueEdu(tx, '0-newest', 'remote.test', 'm.test', {
        source: '0-newest',
      });
      await enqueueEdu(tx, 'z-old', 'remote.test', 'm.test', {
        replaced: true,
      });
    });
    assertEquals(
      (await pendingEdus(server, 'remote.test', 100)).map((e) => e.content),
      [
        { source: 'z-old' },
        { source: 'a-new' },
        { source: '0-newest' },
      ],
    );
    await server.tx((tx) => completeBatch(tx, 'remote.test', frozen));
    assertEquals(
      (await pendingEdus(server, 'remote.test', 100)).map((e) => e.source),
      ['a-new', '0-newest'],
    );
    await store.close();
    store = await openStore(config, { schemas: { server: serverSchema } });
    assertEquals(
      (await pendingEdus(await store.server(), 'remote.test', 100)).map((e) =>
        e.source
      ),
      ['a-new', '0-newest'],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
