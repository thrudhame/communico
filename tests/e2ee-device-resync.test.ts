import { assert, assertEquals, assertThrows } from '@std/assert';
import { SERVER_V13 } from '#tests/fixtures/server-v13.ts';
import { config } from '#engine/config.ts';
import { wireKey } from '#tests/fixtures/e2ee-wire.ts';
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
  keys: { ['ed25519:' + id]: wireKey(material) },
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
      reconcileDeviceRoom(
        tx,
        '!shared:local',
        [observer, user],
        false,
        null,
        1,
        ['local.test'],
      )
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
    assertEquals((cached.A as { keys: unknown }).keys, {
      'ed25519:A': wireKey('900'),
    });
    assertEquals(
      (await deviceListsBetween(db, observer, 0, head, 'sync')).changed,
      [observer, user],
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
      reconcileDeviceRoom(tx, '!shared:local', [observer], false, null, 2, [
        'local.test',
      ])
    );
    assertEquals(await cachedDeviceKeys(db, user, [], observer), null);
    const leaveCut = (await recoveryCut(db, user))!;
    const leaveHead = await deviceStreamMax(db);
    await acceptDeviceDelta(db, delta(2000, []), limits(), 'local.test');
    assertEquals(await recoveryCut(db, user), leaveCut);
    assertEquals(await deviceStreamMax(db), leaveHead);
    await db.tx((tx) =>
      reconcileDeviceRoom(
        tx,
        '!shared:local',
        [observer, user],
        false,
        null,
        3,
        ['local.test'],
      )
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

Deno.test('PAIR503: recovery cannot publish a snapshot behind a held device rename', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(options(dir), {
    schemas: { server: serverSchema },
  });
  const named = (stream: number, name: string) =>
    remoteDeviceSnapshot(
      {
        user_id: user,
        stream_id: stream,
        devices: [{
          device_id: 'D',
          device_display_name: name,
          keys: key('D'),
        }],
      },
      user,
      limits(),
    );
  const rename = (stream: number, prev: number, name: string) =>
    deviceDelta({
      user_id: user,
      device_id: 'D',
      stream_id: stream,
      prev_id: [prev],
      device_display_name: name,
      keys: key('D'),
    }, limits());
  try {
    const db = await store.server();
    await db.tx((tx) =>
      reconcileDeviceRoom(
        tx,
        '!shared:local',
        [observer, user],
        false,
        null,
        1,
        ['local.test'],
      )
    );
    const initial = await recoveryCut(db, user);
    assert(initial);
    assert(await installDeviceSnapshot(db, initial, named(2, 'Old'), limits()));
    // The sender is ahead of the facade serving the snapshot. Hold the
    // missing predecessor 3, and finish recovery only after receiving 5.
    await acceptDeviceDelta(db, rename(5, 3, 'New'), limits());
    const cut = await recoveryCut(db, user);
    assert(cut);
    assertEquals(
      await installDeviceSnapshot(db, cut, named(2, 'Old'), limits()),
      false,
    );
    assertEquals(await cachedDeviceKeys(db, user, [], observer), null);
    const name = async () => {
      const cached = await cachedDeviceKeys(db, user, [], observer);
      return (cached?.D as { unsigned: unknown })?.unsigned;
    };
    // A snapshot at the pending rename's predecessor can catch up by replay.
    assert(await installDeviceSnapshot(db, cut, named(3, 'Old'), limits()));
    assertEquals(await name(), { device_display_name: 'New' });

    await acceptDeviceDelta(db, rename(8, 7, 'Newest'), limits());
    const gap = await recoveryCut(db, user);
    assert(gap);
    assertEquals(
      await installDeviceSnapshot(db, gap, named(3, 'Old'), limits()),
      false,
    );
    // Unfamiliar stream IDs can be authoritative after a gap, even if their
    // numeric value is smaller. Matrix uses predecessor IDs, not arithmetic.
    assert(await installDeviceSnapshot(db, gap, named(1, 'Newest'), limits()));
    assertEquals(await name(), { device_display_name: 'Newest' });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a replaced device cut remembers applied deltas without using them as replay predecessors', async () => {
  const dir = await Deno.makeTempDir();
  let store = await openStore(options(dir), {
    schemas: { server: serverSchema },
  });
  try {
    let db = await store.server();
    const recover = async (stream: number, ids: string[]) => {
      const cut = await recoveryCut(db, user);
      assert(cut);
      return await installDeviceSnapshot(
        db,
        cut,
        snapshot(stream, ids),
        limits(),
      );
    };
    await acceptDeviceDelta(db, delta(10, []), limits());
    assert(await recover(10, ['OLD']));
    const applied = delta(20, [10], 'OLD');
    await acceptDeviceDelta(db, applied, limits());
    const old = (await cachedDeviceKeys(db, user, [], observer))?.OLD;
    assertEquals((old as { keys: unknown }).keys, {
      'ed25519:OLD': wireKey('20'),
    });
    await acceptDeviceDelta(db, delta(40, [30]), limits());
    assert(await recover(40, ['D']));
    await store.close();
    store = await openStore(options(dir), {
      schemas: { server: serverSchema },
    });
    db = await store.server();
    const head = await deviceStreamMax(db);

    // The duplicate must not enqueue recovery or resurrect the removed key.
    await acceptDeviceDelta(db, applied, limits());
    assertEquals(await recoveryCut(db, user), null);
    assertEquals(await deviceStreamMax(db), head);
    const cached = await cachedDeviceKeys(db, user, [], observer);
    assert(cached);
    assertEquals(Object.keys(cached), ['D']);

    // Deduplication must not make a different update linked only to a retired
    // cut safe to apply or replay over the current snapshot.
    await acceptDeviceDelta(db, delta(25, [20], 'OLD'), limits());
    assertEquals(await cachedDeviceKeys(db, user, [], observer), null);
    assertEquals(await recover(20, ['OLD']), false);
    assertEquals(await cachedDeviceKeys(db, user, [], observer), null);
    assertEquals(await recover(40, ['D']), false);
    // An unfamiliar cut can still be authoritative, regardless of its order.
    assert(await recover(5, ['D']));
    assertEquals(
      Object.keys((await cachedDeviceKeys(db, user, [], observer))!),
      [
        'D',
      ],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('PAIR503: a gapped update wakes sync once, when its recovery publishes the new keys', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(options(dir), {
    schemas: { server: serverSchema },
  });
  try {
    const db = await store.server();
    await db.tx((tx) =>
      reconcileDeviceRoom(
        tx,
        '!shared:local',
        [observer, user],
        false,
        null,
        1,
        ['local.test'],
      )
    );
    const initial = await recoveryCut(db, user);
    assert(initial);
    assert(await installDeviceSnapshot(db, initial, snapshot(2), limits()));
    const before = await deviceStreamMax(db);

    // The update arrives before its predecessor, and recovery is held. This
    // gap cannot publish a second change when the same update is recovered.
    await acceptDeviceDelta(db, delta(5, [3]), limits());
    assertEquals(await deviceStreamMax(db), before);
    assertEquals(await cachedDeviceKeys(db, user, [], observer), null);
    const recovered = await recoveryCut(db, user);
    assert(recovered);
    assert(await installDeviceSnapshot(db, recovered, snapshot(5), limits()));
    const announced = await deviceStreamMax(db);
    assertEquals(announced, before + 1);
    assertEquals(
      (await deviceListsBetween(db, observer, before, announced, 'sync'))
        .changed,
      [user],
    );

    // A client that sampled that wake cannot mistake recovery of the first
    // update for the next one. Only release the rename after that read.
    await acceptDeviceDelta(db, delta(9, [5]), limits());
    assertEquals(
      (await deviceListsBetween(
        db,
        observer,
        announced,
        await deviceStreamMax(db),
        'sync',
      )).changed,
      [user],
    );
    assertEquals((await cachedDeviceKeys(db, user, [], observer))?.D, {
      ...key('D', '9'),
      unsigned: {},
    });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('PAIR503: an oversized delta notifies only when its keys become queryable', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(options(dir), {
    schemas: { server: serverSchema },
  });
  try {
    const db = await store.server();
    const small = { ...limits(), maxkeys: 1 };
    await db.tx((tx) =>
      reconcileDeviceRoom(
        tx,
        '!shared:local',
        [observer, user],
        false,
        null,
        1,
        [
          'local.test',
        ],
      )
    );
    const first = await recoveryCut(db, user);
    assert(first);
    assert(await installDeviceSnapshot(db, first, snapshot(10), small));
    const published = await deviceStreamMax(db);
    const initialKeys = await cachedDeviceKeys(db, user, [], observer);
    assert(initialKeys);

    await acceptDeviceDelta(db, delta(20, [10], 'B'), small);
    assertEquals(await cachedDeviceKeys(db, user, [], observer), null);
    assertEquals(await deviceStreamMax(db), published);
    const cut = await recoveryCut(db, user);
    assert(cut);
    // Recovery now has room to publish the same candidate rejected on ingress.
    const next = snapshot(20, ['B']);
    next.devices.push(snapshot(10).devices[0]);
    assert(await installDeviceSnapshot(db, cut, next, limits()));
    const current = await deviceStreamMax(db);
    assertEquals(current, published + 1);
    assertEquals(
      (await deviceListsBetween(db, observer, published, current, 'sync'))
        .changed,
      [user],
    );
    const currentKeys = await cachedDeviceKeys(db, user, [], observer);
    assert(currentKeys);
    assertEquals(Object.keys(currentKeys).sort(), ['B', 'D']);
    assertEquals(currentKeys.D, initialKeys.D);
    assertEquals((currentKeys.B as { keys: unknown }).keys, {
      'ed25519:B': wireKey('20'),
    });
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
      await db.exec(SERVER_V13);
      await db.exec(
        'DROP TABLE federation_join_attempts; DROP TABLE remote_signing_keys; DROP TABLE public_signing_keys; DROP TABLE device_recovery_requests',
      );
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
      reconcileDeviceRoom(
        tx,
        '!reset:local',
        [observer, user],
        false,
        null,
        1,
        ['local.test'],
      )
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
      'ed25519:AT': wireKey('70'),
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
          await db.exec(SERVER_V13);
          await db.exec(
            'DROP TABLE federation_join_attempts; DROP TABLE remote_signing_keys; DROP TABLE public_signing_keys; DROP TABLE device_recovery_requests; DROP TABLE device_subscriptions; DROP TABLE remote_device_keys; DROP TABLE remote_device_users;',
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
      String(serverSchema.version),
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
