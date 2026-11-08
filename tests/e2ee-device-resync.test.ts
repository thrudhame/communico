import { assert, assertEquals, assertThrows } from '@std/assert';
import { config } from '#engine/config.ts';
import {
  deviceDelta,
  deviceStreamId,
  remoteDeviceSnapshot,
} from '#engine/e2ee-remote.ts';
import {
  acceptDeviceDelta,
  cachedDeviceKeys,
  installDeviceSnapshot,
  recoveryCut,
} from '#engine/server/remote-devices.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { tenantSchema } from '#engine/tenant/index.ts';
import { openStore } from '#engine/store/index.ts';
import {
  deviceListsBetween,
  deviceStreamMax,
  reconcileDeviceRoom,
} from '#engine/server/e2ee.ts';

const user = '@bob:remote.test', observer = '@alice:local.test';
const options = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});
const limits = () => config().e2ee;
const key = (id: string, material = id) => ({
  user_id: user,
  device_id: id,
  algorithms: [],
  keys: { ['ed25519:' + id]: material },
  signatures: {},
});
const delta = (
  stream: number | string,
  prev: (number | string)[],
  id = 'D',
  deleted = false,
) =>
  deviceDelta({
    user_id: user,
    device_id: id,
    stream_id: stream,
    prev_id: prev,
    deleted,
    keys: key(id, String(stream)),
  }, limits());
const snapshot = (stream: number | string, ids = ['D']) =>
  remoteDeviceSnapshot(
    {
      user_id: user,
      stream_id: stream,
      devices: ids.map((id) => ({
        device_id: id,
        keys: key(id, String(stream)),
      })),
    },
    user,
    limits(),
  );

Deno.test('causal identifiers normalize integer/string equality without imposing arithmetic succession', () => {
  assertEquals(deviceStreamId('00012'), '12');
  assertEquals(deviceStreamId(12), '12');
  assertEquals(deviceStreamId('18446744073709551615'), '18446744073709551615');
  for (
    const bad of [1.5, -1, Number.MAX_SAFE_INTEGER + 1, '', '1e3', '1.0', 'x']
  ) assertThrows(() => deviceStreamId(bad));
  assertThrows(() =>
    remoteDeviceSnapshot(
      { user_id: observer, stream_id: 1, devices: [] },
      user,
      limits(),
    )
  );
  assertThrows(() =>
    remoteDeviceSnapshot(
      {
        user_id: user,
        stream_id: 1,
        devices: [
          { device_id: 'D', keys: { ...key('D'), user_id: observer } },
        ],
      },
      user,
      limits(),
    )
  );
});

Deno.test('remote cache survives restart stale, replaces authoritative lists and applies nonconsecutive causal branches exactly once', async () => {
  const dir = await Deno.makeTempDir();
  let store = await openStore(options(dir), {
    schemas: { server: serverSchema, tenant: tenantSchema },
  });
  try {
    let db = await store.server();
    await db.tx((tx) =>
      reconcileDeviceRoom(tx, '!shared:local', [observer, user], false, null, 1)
    );
    await acceptDeviceDelta(db, delta(10, []), limits());
    assertEquals(
      await db.query('SELECT user_id FROM device_recovery_requests'),
      [{ user_id: user }],
    );
    assertEquals(await cachedDeviceKeys(db, user, [], observer), null);
    await store.close();
    store = await openStore(options(dir), {
      schemas: { server: serverSchema, tenant: tenantSchema },
    });
    db = await store.server();
    assertEquals(
      await db.query('SELECT user_id FROM device_recovery_requests'),
      [{ user_id: user }],
    );
    const cut = await recoveryCut(db, user);
    assert(cut);
    assert(
      await installDeviceSnapshot(
        db,
        cut,
        snapshot('0010', ['D', 'OLD']),
        limits(),
      ),
    );
    await acceptDeviceDelta(db, delta('900', ['00010'], 'A'), limits());
    await acceptDeviceDelta(db, delta(50, [10], 'B'), limits());
    await acceptDeviceDelta(
      db,
      delta('1000', ['900', '50'], 'OLD', true),
      limits(),
    );
    const head = await deviceStreamMax(db);
    await acceptDeviceDelta(db, delta(1000, [900, 50], 'OLD', true), limits());
    assertEquals(await deviceStreamMax(db), head);
    const cached = await cachedDeviceKeys(db, user, [], observer);
    assert(cached);
    assertEquals(Object.keys(cached).sort(), ['A', 'B', 'D']);
    assertEquals((cached.A as { keys: unknown }).keys, { 'ed25519:A': '900' });
    assertEquals(
      (await deviceListsBetween(db, observer, 0, head, 'sync')).changed,
      [user],
    );
    // Unknown predecessor cannot turn a gap into a complete cache.
    await acceptDeviceDelta(db, delta(1001, [9999]), limits());
    assertEquals(await cachedDeviceKeys(db, user, [], observer), null);
    const emptyCut = await recoveryCut(db, user);
    assert(emptyCut);
    assert(
      await installDeviceSnapshot(db, emptyCut, snapshot(1001, []), limits()),
    );
    assertEquals(await cachedDeviceKeys(db, user, [], observer), {});
    // Losing the last room and then rejoining invalidates atomically, even
    // without an intervening origin mutation or an incoming EDU.
    await db.tx((tx) =>
      reconcileDeviceRoom(tx, '!shared:local', [observer], false, null, 2)
    );
    assertEquals(await cachedDeviceKeys(db, user, [], observer), null);
    const leaveCut = (await recoveryCut(db, user))!;
    const leaveHead = await deviceStreamMax(db);
    await acceptDeviceDelta(db, delta(2000, []), limits(), 'local.test');
    assertEquals(await recoveryCut(db, user), leaveCut);
    assertEquals(await deviceStreamMax(db), leaveHead);
    await db.tx((tx) =>
      reconcileDeviceRoom(tx, '!shared:local', [observer, user], false, null, 3)
    );
    assertEquals(
      await installDeviceSnapshot(db, leaveCut, snapshot(1001), limits()),
      false,
    );
    assertEquals(await cachedDeviceKeys(db, user, [], observer), null);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('v9 lazy-recovery upgrade retains hinted retries and leaves membership-only state dormant', async () => {
  const dir = await Deno.makeTempDir();
  const previous = {
    version: 9,
    apply: async (db: Parameters<typeof serverSchema.apply>[0]) => {
      await serverSchema.apply(db);
      await db.exec('DROP TABLE device_recovery_requests');
    },
  };
  let store = await openStore(options(dir), { schemas: { server: previous } });
  try {
    let db = await store.server();
    await db.exec(
      "INSERT INTO remote_device_users VALUES('@dormant:r',NULL,1,0,0,0,'[]','[]'),('@hint:r',NULL,1,1,123,1,'[]','[]');",
    );
    await store.close();
    store = await openStore(options(dir), {
      schemas: { server: serverSchema },
    });
    db = await store.server();
    assertEquals(
      await db.query('SELECT user_id FROM device_recovery_requests'),
      [{ user_id: '@hint:r' }],
    );
    assertEquals(
      (await db.query(
        "SELECT retry_at,failures FROM remote_device_users WHERE user_id='@hint:r'",
      ))[0],
      { retry_at: 123, failures: 1 },
    );
    await store.close();
    store = await openStore(options(dir), {
      schemas: { server: serverSchema },
    });
    assertEquals(
      await (await store.server()).query(
        'SELECT user_id FROM device_recovery_requests',
      ),
      [{ user_id: '@hint:r' }],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('reset hints and empty snapshots do not repeat a join notification; authoritative key changes do', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(options(dir), {
    schemas: { server: serverSchema },
  });
  try {
    const db = await store.server();
    await db.tx((tx) =>
      reconcileDeviceRoom(tx, '!reset:local', [observer, user], false, null, 1)
    );
    const joined = await deviceStreamMax(db);
    const reset = (stream: number) =>
      deviceDelta({
        user_id: user,
        device_id: 'NO_KEYS',
        stream_id: stream,
        prev_id: [],
      }, limits());
    await acceptDeviceDelta(db, reset(10), limits());
    assertEquals(
      await deviceStreamMax(db),
      joined,
      'a reset is a recovery hint, not an additional key mutation',
    );
    assert(
      await installDeviceSnapshot(
        db,
        (await recoveryCut(db, user))!,
        snapshot(10, []),
        limits(),
      ),
    );
    assertEquals(
      await deviceStreamMax(db),
      joined,
      'learning an empty authoritative list must not fabricate a mutation',
    );
    await acceptDeviceDelta(db, reset(20), limits());
    assert(
      await installDeviceSnapshot(
        db,
        (await recoveryCut(db, user))!,
        snapshot(20),
        limits(),
      ),
    );
    const changed = await deviceStreamMax(db);
    assert(changed > joined);
    assertEquals(
      (await deviceListsBetween(db, observer, joined, changed, 'sync')).changed,
      [user],
    );
    assertEquals(
      Object.keys((await cachedDeviceKeys(db, user, [], observer))!),
      ['D'],
    );
    await acceptDeviceDelta(db, reset(30), limits());
    const same = { ...snapshot(20), stream: '30' };
    assert(
      await installDeviceSnapshot(
        db,
        (await recoveryCut(db, user))!,
        same,
        limits(),
      ),
    );
    assertEquals(
      await deviceStreamMax(db),
      changed,
      'a new causal anchor with identical public material is not a key change',
    );
    await acceptDeviceDelta(db, reset(40), limits());
    assert(
      await installDeviceSnapshot(
        db,
        (await recoveryCut(db, user))!,
        snapshot(40, []),
        limits(),
      ),
    );
    assert(
      (await deviceStreamMax(db)) > changed,
      'removing the last key must notify',
    );
    assertEquals(await cachedDeviceKeys(db, user, [], observer), {});
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('snapshot race replays only provably subsequent deltas and never overwrites a newer invalidation', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(options(dir), {
    schemas: { server: serverSchema },
  });
  try {
    const db = await store.server();
    await acceptDeviceDelta(db, delta(10, []), limits());
    const first = (await recoveryCut(db, user))!;
    await acceptDeviceDelta(db, delta(20, [10], 'LATE'), limits());
    assert(await installDeviceSnapshot(db, first, snapshot(10), limits()));
    assertEquals(
      Object.keys((await cachedDeviceKeys(db, user, [], observer))!).sort(),
      ['D', 'LATE'],
    );
    await acceptDeviceDelta(db, delta(30, []), limits());
    const older = (await recoveryCut(db, user))!;
    await acceptDeviceDelta(db, delta(40, [], 'NEW'), limits());
    assertEquals(
      await installDeviceSnapshot(db, older, snapshot(30), limits()),
      false,
    );
    assertEquals(await cachedDeviceKeys(db, user, [], observer), null);
    const newer = (await recoveryCut(db, user))!;
    assert(
      await installDeviceSnapshot(db, newer, snapshot(40, ['NEW']), limits()),
    );
    assertEquals(
      await installDeviceSnapshot(db, older, snapshot(30), limits()),
      false,
    );
    assertEquals(
      Object.keys((await cachedDeviceKeys(db, user, [], observer))!),
      ['NEW'],
    );
    await acceptDeviceDelta(db, delta(50, []), limits());
    const overlap = (await recoveryCut(db, user))!;
    await acceptDeviceDelta(db, delta(60, [50], 'BEFORE'), limits());
    await acceptDeviceDelta(db, delta(70, [60], 'AT'), limits());
    await acceptDeviceDelta(db, delta(80, [70], 'AFTER'), limits());
    assert(
      await installDeviceSnapshot(db, overlap, snapshot(70, ['AT']), limits()),
    );
    const covered = (await cachedDeviceKeys(db, user, [], observer))!;
    assertEquals(Object.keys(covered).sort(), ['AFTER', 'AT']);
    assertEquals((covered.AT as { keys: unknown }).keys, {
      'ed25519:AT': '70',
    });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('pending and cache overflow stay bounded and stale; supported v7 upgrade preserves reliable delivery', async () => {
  const dir = await Deno.makeTempDir();
  let store = await openStore(options(dir), {
    schemas: {
      server: {
        version: 7,
        apply: async (db) => {
          await serverSchema.apply(db);
          await db.exec(
            'DROP TABLE device_recovery_requests; DROP TABLE device_subscriptions; DROP TABLE remote_device_keys; DROP TABLE remote_device_users;',
          );
        },
      },
    },
  });
  try {
    await (await store.server()).execute(
      "INSERT INTO edu_outbox VALUES('kept','remote.test','m.test','{}','pending',1)",
    );
    await store.close();
    store = await openStore(options(dir), {
      schemas: { server: serverSchema },
    });
    const db = await store.server();
    assertEquals(
      (await db.query("SELECT v FROM meta WHERE k='schema_version'"))[0].v,
      '10',
    );
    assertEquals(
      (await db.query('SELECT source FROM edu_outbox'))[0].source,
      'kept',
    );
    const small = { ...limits(), maxkeys: 2 };
    for (let i = 1; i <= 5; i++) {
      await acceptDeviceDelta(db, delta(i, []), small);
    }
    const row =
      (await db.query('SELECT pending,stale FROM remote_device_users'))[0];
    assert(JSON.parse(String(row.pending)).length <= 2);
    assertEquals(row.stale, 1);
    const cut = (await recoveryCut(db, user))!;
    assert(
      await installDeviceSnapshot(db, cut, snapshot(5, ['A', 'B']), small),
    );
    await acceptDeviceDelta(db, delta(6, [5], 'C'), small);
    assertEquals(await cachedDeviceKeys(db, user, [], observer), null);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
