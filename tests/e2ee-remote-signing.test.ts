import { assert, assertEquals, assertRejects } from '@std/assert';
import { config } from '#engine/config.ts';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { deviceStreamMax, reconcileDeviceRoom } from '#engine/server/e2ee.ts';
import {
  acceptDeviceDelta,
  acceptSigningUpdate,
  cachedKeyQuery,
  installDeviceSnapshot,
  recoveryCut,
} from '#engine/server/remote-devices.ts';
import { deviceDelta, remoteDeviceSnapshot } from '#engine/e2ee-remote.ts';
import { publicSigning } from '#engine/e2ee-public-signing.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
} from '#engine/signing-primitives.js';

const user = '@bob:remote.test', observer = '@alice:local.test';
async function master() {
  const pair = await generateSigningKeypair() as CryptoKeyPair;
  const pub = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
  return {
    user_id: user,
    usage: ['master'],
    keys: { ['ed25519:' + pub]: pub },
  };
}

Deno.test('remote signing revision rejects a late device snapshot over rotation; upgrade and restart preserve authoritative views', async () => {
  const dir = await Deno.makeTempDir(), limits = config().e2ee;
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const old = {
    version: 11,
    apply: async (db: Parameters<typeof serverSchema.apply>[0]) => {
      await serverSchema.apply(db);
      await db.exec('DROP TABLE remote_signing_keys');
      await db.exec('DROP TABLE federation_join_attempts');
    },
  };
  let store = await openStore(options, { schemas: { server: old } });
  try {
    let db = await store.server();
    await db.tx(async (tx) => {
      await tx.execute(
        "INSERT INTO remote_device_users VALUES(?,NULL,1,0,0,0,'[]','[]')",
        [user],
      );
      await tx.execute(
        "INSERT INTO edu_outbox VALUES('retained','remote.test','m.direct_to_device','{}','pending',1)",
      );
    });
    await store.close();
    store = await openStore(options, { schemas: { server: serverSchema } });
    db = await store.server();
    assertEquals(
      (await db.query('SELECT source FROM edu_outbox'))[0].source,
      'retained',
    );
    await db.tx((tx) =>
      reconcileDeviceRoom(tx, '!shared:local', [observer, user], false, null, 1)
    );
    const first = await master(), second = await master();
    const snapshot = (key?: Record<string, unknown>) =>
      remoteDeviceSnapshot(
        {
          user_id: user,
          stream_id: 10,
          devices: [],
          ...(key ? { master_key: key } : {}),
        },
        user,
        limits,
      );
    const cut = (await recoveryCut(db, user))!;
    await acceptSigningUpdate(
      db,
      user,
      publicSigning({ master_key: second }, user, limits),
      limits,
      'local.test',
    );
    assertEquals(
      await installDeviceSnapshot(db, cut, snapshot(first), limits),
      false,
      'late snapshot overwrote EDU rotation',
    );
    const current = (await recoveryCut(db, user))!;
    assert(await installDeviceSnapshot(db, current, snapshot(second), limits));
    const expected = await cachedKeyQuery(db, user, [], observer);
    assertEquals((expected!.master_keys as Record<string, unknown>)[user], {
      ...second,
      signatures: {},
    });
    const head = await deviceStreamMax(db);
    await acceptSigningUpdate(
      db,
      user,
      publicSigning({ master_key: second }, user, limits),
      limits,
      'local.test',
    );
    assertEquals(await deviceStreamMax(db), head);
    await store.close();
    store = await openStore(options, { schemas: { server: serverSchema } });
    db = await store.server();
    assertEquals(await cachedKeyQuery(db, user, [], observer), expected);
    // A malformed authoritative subordinate cannot replace the complete view.
    await assertRejects(() =>
      installDeviceSnapshot(db, current, {
        ...snapshot(first),
        signing: { self_signing_key: first },
      }, limits)
    );
    assertEquals(await cachedKeyQuery(db, user, [], observer), expected);
    await acceptDeviceDelta(
      db,
      deviceDelta({
        user_id: user,
        device_id: '',
        deleted: true,
        stream_id: 20,
        prev_id: [],
      }, limits),
      limits,
    );
    assert(
      await installDeviceSnapshot(
        db,
        (await recoveryCut(db, user))!,
        snapshot(),
        limits,
      ),
    );
    assertEquals(await cachedKeyQuery(db, user, [], observer), {
      device_keys: { [user]: {} },
    });
    assert(
      (await deviceStreamMax(db)) > head,
      'removing final signing key must notify',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
