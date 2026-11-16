import { assert, assertEquals } from '@std/assert';
import { config } from '#engine/config.ts';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import { openStore } from '#engine/store/index.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';
import { project, sourceOf } from '#engine/server/project.ts';
import { completeBatch, type FrozenBatch } from '#engine/server/delivery.ts';
import { reconcileDeviceSubscriptions } from '#engine/server/device-federation.ts';
import {
  acceptDeviceDelta,
  cachedDeviceKeys,
  installDeviceSnapshot,
  invalidateDeviceCache,
  recoveryCut,
} from '#engine/server/remote-devices.ts';
import { deviceDelta, remoteDeviceSnapshot } from '#engine/e2ee-remote.ts';
import { genesis } from '#tests/fixtures/genesis.ts';
import { wireKey } from '#tests/fixtures/e2ee-wire.ts';

async function withDb(fn: (db: Db) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const db = await Db.open(ffi, dir + '/data.db', 65536);
  try {
    await serverSchema.apply(db);
    await fn(db);
  } finally {
    await db.close();
    ffi.close();
    await Deno.remove(dir, { recursive: true });
  }
}

// Observe actual native affected rows, including deletions, not SQL call count.
async function measure(owner: string, fn: () => Promise<void>) {
  const execute = Turso.prototype.execute;
  const writes: Record<string, number> = {};
  Turso.prototype.execute = async function (...args) {
    const n = await execute.apply(this, args);
    const table = /^(?:INSERT INTO|UPDATE|DELETE FROM) (\w+)/.exec(args[1])
      ?.[1];
    if (table) writes[table] = (writes[table] ?? 0) + n;
    return n;
  };
  const start = performance.now();
  try {
    await fn();
  } finally {
    Turso.prototype.execute = execute;
  }
  console.log(
    JSON.stringify({ owner, writes, elapsed_ms: performance.now() - start }),
  );
  return writes;
}

Deno.test('server hot-path work: replayed projection preserves equal status, live seq and relations', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, {
    schemas: { room: roomSchema, tenant: tenantSchema, server: serverSchema },
  });
  try {
    const g = await genesis(store, { roomId: '!work:test' });
    await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: {
        body: 'reply',
        'm.relates_to': { rel_type: 'm.thread', event_id: g.createId },
      },
      origin_server_ts: 100,
    }, g.signer);
    await project(store, g.roomId);
    const server = await store.server();
    const before = await server.query(
      'SELECT * FROM event_index ORDER BY event',
    );
    const relations = await server.query('SELECT * FROM relations');
    assertEquals(relations.length, 1);
    // Exercise the idempotent application contract rather than the outer no-op watermark.
    await server.execute('DELETE FROM watermarks WHERE source=?', [
      sourceOf(g.roomId),
    ]);
    const writes = await measure(
      'projection replay',
      () => project(store, g.roomId),
    );
    assertEquals(
      await server.query('SELECT * FROM event_index ORDER BY event'),
      before,
    );
    assertEquals(await server.query('SELECT * FROM relations'), relations);
    // Distinct log occurrences can revisit a retained nonlive event identity.
    const original = await g.room.tx((tx) => tx.changes.after(0, 100));
    const payload = {
      ...JSON.parse(
        original.find((c) => c.event === g.createId && c.kind === 'event')!
          .data,
      ),
      stay: null,
    };
    await g.room.tx(async (tx) => {
      await tx.changes.append('transition', g.createId, payload);
      await tx.changes.append('history', g.createId, payload);
    });
    const revisited = await measure(
      'projection status revisit',
      () => project(store, g.roomId),
    );
    assertEquals(
      await server.query('SELECT * FROM event_index ORDER BY event'),
      before,
    );
    assertEquals(revisited.event_index, 0);
    assertEquals(writes.event_index, 0);
    assertEquals(writes.relations, 0);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('server hot-path work: repeated frozen completion writes only changed matching generations', () =>
  withDb(async (db) => {
    const batch: FrozenBatch = {
      txnId: 'old',
      body: 'exact',
      rows: [],
      sources: [],
    };
    for (let pos = 1; pos <= 34; pos++) {
      await db.execute(
        "INSERT INTO outbox(room,pos,destination,event,state,added_ms) VALUES('!r:test',?,'peer.test',?,'pending',1)",
        [pos, '$' + pos],
      );
      batch.rows.push({
        room: '!r:test',
        pos,
        destination: 'peer.test',
        event: '$' + pos,
        seq: pos,
        attempts: 0,
        addedMs: 1,
      });
    }
    await db.execute("UPDATE outbox SET state='sent' WHERE pos<=32");
    await db.execute('UPDATE outbox SET added_ms=2 WHERE pos=34');
    await db.execute(
      "INSERT INTO edu_outbox(source,destination,edu_type,payload,state,enqueue_pos) VALUES('generic','peer.test','m.test','{}','pending',1)",
    );
    batch.sources.push('generic');
    await db.execute(
      "INSERT INTO federation_batches VALUES('peer.test','newer','other','[]','[]')",
    );
    const first = await measure(
      'frozen completion changed',
      () => db.tx((tx) => completeBatch(tx, 'peer.test', batch)),
    );
    const repeated = await measure(
      'frozen completion replay',
      () => db.tx((tx) => completeBatch(tx, 'peer.test', batch)),
    );
    assertEquals(
      await db.query("SELECT pos FROM outbox WHERE state='pending'"),
      [{ pos: 34 }],
    );
    assertEquals(await db.query('SELECT txn_id FROM federation_batches'), [{
      txn_id: 'newer',
    }]);
    assertEquals(first.outbox, 1);
    assertEquals(first.edu_outbox, 1);
    assertEquals(repeated.outbox, 0);
    assertEquals(repeated.edu_outbox, 0);
  }));

Deno.test('server hot-path work: subscription reconciliation never rewrites retained inactive destinations', () =>
  withDb(async (db) => {
    const user = '@a:local.test';
    for (let i = 0; i < 33; i++) {
      await db.execute(
        'INSERT INTO device_subscriptions VALUES(?,?,?,1,10,5)',
        [user, `old${i}.test`, i === 32 ? 1 : 0],
      );
    }
    await db.execute(
      "INSERT INTO device_tracking VALUES('@b:wanted.test',?,'keys',1,NULL)",
      [user],
    );
    const reconcile = () =>
      db.tx((tx) => reconcileDeviceSubscriptions(tx, [user], ['local.test']));
    const first = await measure('subscriptions changed', reconcile);
    const second = await measure('subscriptions replay', reconcile);
    assertEquals(
      (await db.query(
        'SELECT COUNT(*) AS n FROM device_subscriptions WHERE active=0',
      ))[0].n,
      33,
    );
    assertEquals(
      await db.query(
        "SELECT active,epoch,queued_stream FROM device_subscriptions WHERE destination='wanted.test'",
      ),
      [{ active: 1, epoch: 1, queued_stream: 0 }],
    );
    assertEquals(
      (await db.query('SELECT COUNT(*) AS n FROM edu_outbox'))[0].n,
      1,
    );
    assertEquals(first.device_subscriptions, 2);
    assertEquals(second.device_subscriptions ?? 0, 0);
  }));

Deno.test('server hot-path work: authoritative snapshots and causal deltas write only changed semantic keys', () =>
  withDb(async (db) => {
    const user = '@b:remote.test';
    const limits = config().e2ee;
    const key = (id: string, material = id) => ({
      user_id: user,
      device_id: id,
      algorithms: [],
      keys: { ['ed25519:' + id]: wireKey(material) },
      signatures: {},
    });
    const snapshot = (stream: number, ids: string[], rotated = '') =>
      remoteDeviceSnapshot(
        {
          user_id: user,
          stream_id: stream,
          devices: ids.map((id) => ({
            device_id: id,
            keys: key(id, id === rotated ? 'rotated' : id),
          })),
        },
        user,
        limits,
      );
    const ids = Array.from({ length: 32 }, (_, i) => 'D' + i);
    await db.execute(
      "INSERT INTO remote_device_users VALUES(?,NULL,1,0,0,0,'[]','[]')",
      [user],
    );
    assert(
      await installDeviceSnapshot(
        db,
        (await recoveryCut(db, user))!,
        snapshot(1, ids),
        limits,
      ),
    );
    await db.tx((tx) => invalidateDeviceCache(tx, user));
    const equal = await measure('snapshot equal', async () => {
      assert(
        await installDeviceSnapshot(
          db,
          (await recoveryCut(db, user))!,
          snapshot(2, ids),
          limits,
        ),
      );
    });
    assertEquals(
      Object.keys((await cachedDeviceKeys(db, user, [], '@a:test'))!).length,
      32,
    );
    await db.tx((tx) => invalidateDeviceCache(tx, user));
    const changed = await measure(
      'snapshot one rotation removal addition',
      async () => {
        assert(
          await installDeviceSnapshot(
            db,
            (await recoveryCut(db, user))!,
            snapshot(3, [...ids.slice(1), 'NEW'], 'D1'),
            limits,
          ),
        );
      },
    );
    const keys = (await cachedDeviceKeys(db, user, [], '@a:test'))!;
    assertEquals(Object.keys(keys).sort(), [...ids.slice(1), 'NEW'].sort());
    assertEquals(
      (keys.D1 as { keys: unknown }).keys,
      key('D1', 'rotated').keys,
    );
    // Property order differs but its semantic key is unchanged; the causal cut still advances.
    const d = deviceDelta({
      user_id: user,
      device_id: 'D2',
      stream_id: 4,
      prev_id: [3],
      keys: {
        signatures: {},
        keys: key('D2').keys,
        algorithms: [],
        device_id: 'D2',
        user_id: user,
      },
    }, limits);
    const delta = await measure(
      'equal key new causal delta',
      () => acceptDeviceDelta(db, d, limits),
    );
    assertEquals(
      (await db.query('SELECT anchor FROM remote_device_users'))[0].anchor,
      '4',
    );
    assertEquals(equal.remote_device_keys ?? 0, 0);
    assertEquals(changed.remote_device_keys, 3);
    assertEquals(delta.remote_device_keys ?? 0, 0);
  }));
