import { assert, assertEquals, assertRejects } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { reconcileDeviceRoom } from '#engine/server/e2ee.ts';
import { reconcileDeviceSubscriptions } from '#engine/server/device-federation.ts';
import {
  installDeviceSnapshot,
  recoveryCut,
} from '#engine/server/remote-devices.ts';
import { remoteDeviceSnapshot } from '#engine/e2ee-remote.ts';
import { clearSigningKeys } from '#engine/tenant/cross-signing.ts';
import { signingUpload } from '#engine/e2ee-signing.ts';
import { validateUpload } from '#engine/tenant/e2ee.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { type Sender, startSender } from '#engine/federation/sender.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { startFakeServer } from '#tests/federation/fake-server.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
  signJson,
} from '#engine/signing-primitives.js';

async function fixture(
  run: (store: Awaited<ReturnType<typeof openStore>>) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema, tenant: tenantSchema } });
  try {
    await run(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('E2EE follow-ups: remote-only transitions do not stale a locally observed cache', () =>
  fixture(async (store) => {
    const db = await store.server();
    const user = '@a:remote.test';
    await db.tx((tx) =>
      reconcileDeviceRoom(
        tx,
        '!local:local.test',
        ['@local:local.test', user],
        false,
        null,
        1,
        ['local.test'],
      )
    );
    const cut = await recoveryCut(db, user);
    assert(cut);
    assert(
      await installDeviceSnapshot(
        db,
        cut,
        remoteDeviceSnapshot(
          { user_id: user, stream_id: 1, devices: [] },
          user,
          config().e2ee,
        ),
        config().e2ee,
      ),
    );
    await db.tx((tx) =>
      reconcileDeviceRoom(
        tx,
        '!remote:remote.test',
        ['@b:another.test', user],
        false,
        null,
        1,
        ['local.test'],
      )
    );
    assertEquals(
      (await db.query('SELECT stale FROM remote_device_users WHERE user_id=?', [
        user,
      ]))[0].stale,
      0,
    );
  }));

Deno.test('E2EE follow-ups: startup reconciliation batches unchanged tracking and subscription reads', () =>
  fixture(async (store) => {
    const db = await store.server();
    const subjects = Array.from(
      { length: 100 },
      (_, i) => `@u${i}:remote.test`,
    );
    await db.tx(async (tx) => {
      for (const user of subjects) {
        await tx.execute(
          "INSERT INTO device_tracking VALUES(?,?,'keys',1,NULL)",
          ['@local:local.test', user],
        );
      }
    });
    await db.tx(async (tx) => {
      const query = tx.query.bind(tx);
      let reads = 0;
      tx.query = (...args) => {
        reads++;
        return query(...args);
      };
      const started = performance.now();
      try {
        await reconcileDeviceSubscriptions(tx, subjects, ['local.test']);
      } finally {
        tx.query = query;
      }
      console.log(
        JSON.stringify({
          subjects: subjects.length,
          subscriptionReads: reads,
          elapsedMs: performance.now() - started,
        }),
      );
      assert(reads <= 2, `unchanged subjects used ${reads} reads`);
    });
  }));

Deno.test('E2EE follow-ups: clearing absent signing keys does not publish public changes', () =>
  fixture(async (store) => {
    const tenant = await openTenant(store, 'local.test', { create: true });
    const db = await store.tenant('local.test');
    await db.tx((tx) =>
      clearSigningKeys(
        tx,
        'a',
        '@a:local.test',
        config().federation.bulkmaxbytes,
      )
    );
    assertEquals(await db.query('SELECT * FROM e2ee_changes'), []);
    await tenant.tx((tx) => tx.users.insert('a', 'A'));
  }));

Deno.test('E2EE follow-ups: local unchanged subscriptions use bounded batch reads', () =>
  fixture(async (store) => {
    const db = await store.server();
    const subjects = Array.from(
      { length: 100 },
      (_, i) => '@u' + i + ':local.test',
    );
    await db.tx(async (tx) => {
      for (const user of subjects) {
        await tx.execute(
          "INSERT INTO device_tracking VALUES(?,?,'keys',1,NULL)",
          ['@peer:remote.test', user],
        );
        await tx.execute(
          'INSERT INTO device_subscriptions VALUES(?,?,1,?,?,NULL)',
          [user, 'remote.test', 1, 0],
        );
      }
      const query = tx.query.bind(tx);
      let reads = 0;
      tx.query = (...args) => {
        reads++;
        return query(...args);
      };
      try {
        await reconcileDeviceSubscriptions(tx, subjects, ['local.test']);
      } finally {
        tx.query = query;
      }
      assertEquals(reads, 2);
    });
  }));

Deno.test('E2EE follow-ups: device snapshots must fit a standalone reliable envelope before acceptance', () =>
  fixture(async (store) => {
    const tenant = await openTenant(store, 'local.test', { create: true });
    const previous = config().federation;
    const db = await store.tenant('local.test');
    await tenant.tx((tx) => tx.users.insert('a', 'A'));
    try {
      setConfigForTests({ federation: { bulkmaxbytes: 512 } });
      await assertRejects(() =>
        tenant.tx((tx) => tx.devices.upsert('D', 'a', 'x'.repeat(1000)))
      );
      assertEquals(await tenant.tx((tx) => tx.devices.ofUser('a')), []);
      assertEquals(await db.query('SELECT * FROM e2ee_changes'), []);
      await tenant.tx((tx) => tx.devices.upsert('D', 'a', 'D'));
      const device = (await tenant.tx((tx) => tx.devices.byId('D', 'a')))!;
      const before = await db.query('SELECT * FROM e2ee_changes');
      await assertRejects(() =>
        tenant.tx((tx) => tx.devices.rename('D', 'a', 'x'.repeat(1000)))
      );
      const input = validateUpload(
        {
          device_keys: {
            user_id: '@a:local.test',
            device_id: 'D',
            algorithms: [],
            keys: { 'ed25519:D': 'x'.repeat(1000) },
            signatures: {},
          },
        },
        '@a:local.test',
        'D',
        config().e2ee,
      );
      await assertRejects(() =>
        tenant.tx((tx) =>
          tx.e2ee.upload({
            localpart: 'a',
            deviceId: 'D',
            generation: device.generation,
          }, input)
        )
      );
      assertEquals(await db.query('SELECT * FROM e2ee_changes'), before);
      assertEquals(await db.query('SELECT * FROM device_keys'), []);
      assertEquals(
        (await tenant.tx((tx) => tx.devices.byId('D', 'a')))!.display_name,
        'D',
      );
    } finally {
      setConfigForTests({ federation: previous });
    }
  }));

Deno.test('E2EE follow-ups: device replacement and deletion publish removed public master signatures', () =>
  fixture(async (store) => {
    const tenant = await openTenant(store, 'local.test', { create: true });
    const previous = config().federation;
    setConfigForTests({
      federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
    });
    resetCaCertsForTests();
    let sender: Sender | undefined;
    const received: Record<string, unknown>[] = [];
    const fake = await startFakeServer({
      ourKeyDoc: () =>
        Promise.resolve({
          server_name: tenant.serverName,
          verify_keys: { [tenant.keyId]: { key: tenant.publicB64 } },
        }),
      handlers: (req) => {
        if (!req.path.includes('/send/')) return null;
        assert(req.verified);
        received.push(
          ...(req.json() as {
            edus: { edu_type: string; content: Record<string, unknown> }[];
          }).edus.filter((e) => e.edu_type === 'm.signing_key_update').map((
            e,
          ) => e.content),
        );
        return Response.json({ pdus: {} });
      },
    });
    try {
      const user = '@a:local.test';
      await tenant.tx((tx) => tx.users.insert('a', 'A'));
      const masterPair = await generateSigningKeypair() as CryptoKeyPair;
      const pub = b64encodeStd(await exportPublicKeyRaw(masterPair.publicKey));
      const master = {
        user_id: user,
        usage: ['master'],
        keys: { ['ed25519:' + pub]: pub },
      };
      await tenant.tx((tx) =>
        tx.crossSigning.upload(
          'a',
          user,
          signingUpload({ master_key: master }, user, config().e2ee),
          '{}',
          false,
        )
      );
      const db = await store.server();
      await db.tx((tx) =>
        reconcileDeviceRoom(
          tx,
          '!signing:local.test',
          [user, '@peer:' + fake.name],
          false,
          null,
          1,
          ['local.test'],
        )
      );
      for (const action of ['replace', 'delete']) {
        const pair = await generateSigningKeypair() as CryptoKeyPair;
        const devicePub = b64encodeStd(
          await exportPublicKeyRaw(pair.publicKey),
        );
        await tenant.tx((tx) => tx.devices.upsert('D', 'a', null));
        const device = await tenant.tx((tx) => tx.devices.byId('D', 'a'));
        const identity = {
          localpart: 'a',
          deviceId: 'D',
          generation: device!.generation,
        };
        const upload = (value: string) =>
          validateUpload(
            {
              device_keys: {
                user_id: user,
                device_id: 'D',
                keys: { 'ed25519:D': value },
                algorithms: [],
                signatures: {},
              },
            },
            user,
            'D',
            config().e2ee,
          );
        await tenant.tx((tx) => tx.e2ee.upload(identity, upload(devicePub)));
        const signed = structuredClone(master);
        await signJson(signed, user, 'ed25519:D', pair.privateKey);
        assertEquals(
          await tenant.tx((tx) =>
            tx.keySignatures.upload('a', user, [{
              user,
              id: pub,
              json: signed,
            }])
          ),
          { failures: {} },
        );
        await projectTenant(store, 'local.test');
        assert(
          JSON.stringify(
            await db.query('SELECT payload FROM public_signing_keys'),
          ).includes('ed25519:D'),
        );
        if (action === 'delete') {
          await tenant.tx((tx) => tx.devices.delete('D', 'a'));
        } else {
          const replacement = await generateSigningKeypair() as CryptoKeyPair;
          const replacementPub = b64encodeStd(
            await exportPublicKeyRaw(replacement.publicKey),
          );
          await tenant.tx((tx) =>
            tx.e2ee.upload(identity, upload(replacementPub))
          );
        }
        const local = await tenant.tx((tx) =>
          tx.crossSigning.views('a', user, '')
        );
        assert(!JSON.stringify(local).includes('ed25519:D'));
        await projectTenant(store, 'local.test');
        assert(
          !JSON.stringify(
            await db.query('SELECT payload FROM public_signing_keys'),
          ).includes('ed25519:D'),
          action + ' must publish the changed public view',
        );
        const queued = await db.query(
          "SELECT payload FROM edu_outbox WHERE edu_type='m.signing_key_update' ORDER BY enqueue_pos DESC LIMIT 1",
        );
        assertEquals(
          JSON.parse(String(queued[0].payload)).master_key,
          local.master_keys,
        );
        const before = received.length;
        sender = startSender({ store, signer: tenant.signer() });
        const deadline = Date.now() + 8000;
        while (received.length < before + 2) {
          assert(
            Date.now() < deadline,
            'peer did not observe signed and removed views',
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await sender.stop();
        sender = undefined;
        assert(
          JSON.stringify(received.at(-2)!.master_key).includes('ed25519:D'),
        );
        assertEquals(
          received.at(-1)!.master_key,
          local.master_keys,
          action + ' reaches the signed federation consumer',
        );
      }
    } finally {
      await sender?.stop();
      await fake.close();
      setConfigForTests({ federation: previous });
      resetCaCertsForTests();
    }
  }));
