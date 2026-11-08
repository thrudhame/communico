import { assert, assertEquals } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { keyView } from '#engine/e2ee-key-view.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { reconcileDeviceRoom } from '#engine/server/e2ee.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { advance } from '#engine/store/watermark.ts';
import { type Sender, startSender } from '#engine/federation/sender.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { signingUpload } from '#engine/e2ee-signing.ts';
import { startFakeServer } from './federation/fake-server.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
} from '#engine/signing-primitives.js';

const options = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});
async function waitFor(predicate: () => Promise<boolean> | boolean) {
  const until = Date.now() + 8000;
  while (!await predicate()) {
    assert(Date.now() < until, 'signing federation consumer timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function master(user: string) {
  const pair = await generateSigningKeypair() as CryptoKeyPair;
  const pub = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
  return signingUpload(
    {
      master_key: {
        user_id: user,
        usage: ['master'],
        keys: { ['ed25519:' + pub]: pub },
      },
    },
    user,
    config().e2ee,
  );
}

Deno.test('public signing projection replays old intents, seeds subscriptions and preserves frozen rotations over restart', async () => {
  const dir = await Deno.makeTempDir(), previous = config().federation;
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  const previousServer = {
    version: 10,
    apply: async (db: Parameters<typeof serverSchema.apply>[0]) => {
      await serverSchema.apply(db);
      await db.exec('DROP TABLE public_signing_keys');
      await db.exec('DROP TABLE remote_signing_keys');
    },
  };
  let store = await openStore(options(dir), {
    schemas: { tenant: tenantSchema, server: previousServer },
  });
  let tenant = await openTenant(store, 'local.test', { create: true });
  const alice = '@a:local.test';
  let sender: Sender | undefined, accept = false;
  const attempts: { path: string; raw: string }[] = [],
    received: Record<string, unknown>[] = [];
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: tenant.serverName,
        verify_keys: { [tenant.keyId]: { key: tenant.publicB64 } },
      }),
    handlers: (req) => {
      if (!req.path.includes('/send/')) return null;
      assert(req.verified);
      attempts.push({
        path: req.path,
        raw: new TextDecoder().decode(req.body!),
      });
      if (accept) {
        received.push(
          ...(req.json() as {
            edus: { edu_type: string; content: Record<string, unknown> }[];
          }).edus.filter((e) => e.edu_type === 'm.signing_key_update').map(
            (e) => e.content,
          ),
        );
      }
      return Response.json({ pdus: {} }, { status: accept ? 200 : 503 });
    },
  });
  const bob = '@b:' + fake.name;
  try {
    await tenant.tx((tx) => tx.users.insert('a', 'A'));
    const first = await master(alice), second = await master(alice);
    await tenant.tx((tx) =>
      tx.crossSigning.upload('a', alice, first, '{}', false)
    );
    let db = await store.server();
    // Simulate the earlier E4 projector having consumed this retained intent.
    const tdb = await store.tenant('local.test');
    const last = Number(
      (await tdb.query('SELECT MAX(pos) AS pos FROM e2ee_changes'))[0].pos,
    );
    await db.tx((tx) => advance(tx, 'tenant:local.test:e2ee', last));
    await store.close();
    store = await openStore(options(dir), {
      schemas: { tenant: tenantSchema, server: serverSchema },
    });
    tenant = await openTenant(store, 'local.test');
    db = await store.server();
    await projectTenant(store, 'local.test');
    await db.tx((tx) =>
      reconcileDeviceRoom(tx, '!plain:local', [alice, bob], false, null, 1, [
        'local.test',
      ])
    );
    sender = startSender({ store, signer: tenant.signer() });
    await waitFor(() => attempts.length > 0);
    assert(
      attempts[0].raw.includes('m.signing_key_update'),
      'first subscription must carry current public signing keys',
    );
    await sender.stop();
    sender = undefined;
    await tenant.tx((tx) =>
      tx.crossSigning.upload('a', alice, second, canonicalJson(first), true)
    );
    await projectTenant(store, 'local.test');
    await store.close();
    store = await openStore(options(dir), {
      schemas: { tenant: tenantSchema, server: serverSchema },
    });
    tenant = await openTenant(store, 'local.test');
    db = await store.server();
    accept = true;
    sender = startSender({ store, signer: tenant.signer() });
    await waitFor(() => received.length === 2);
    assertEquals(attempts[1], attempts[0]);
    assertEquals(received.map((r) => r.master_key), [
      keyView(JSON.parse(first.master!.json), alice),
      keyView(JSON.parse(second.master!.json), alice),
    ]);
    assert(received.every((r) => !Object.hasOwn(r, 'user_signing_key')));
    await waitFor(async () =>
      !(await db.query(
        "SELECT 1 FROM edu_outbox WHERE edu_type='m.signing_key_update'",
      )).length
    );
    await projectTenant(store, 'local.test');
    assertEquals(
      (await db.query(
        "SELECT 1 FROM edu_outbox WHERE edu_type='m.signing_key_update'",
      )).length,
      0,
    );
    await db.tx((tx) =>
      reconcileDeviceRoom(tx, '!plain:local', [alice], false, null, 2, [
        'local.test',
      ])
    );
    await db.tx((tx) =>
      reconcileDeviceRoom(tx, '!plain:local', [alice, bob], false, null, 3, [
        'local.test',
      ])
    );
    sender.wake(fake.name);
    await waitFor(() => received.length === 3);
    assertEquals(
      received[2].master_key,
      keyView(JSON.parse(second.master!.json), alice),
    );
  } finally {
    await sender?.stop();
    await fake.close();
    await store.close();
    setConfigForTests({ federation: previous });
    resetCaCertsForTests();
    await Deno.remove(dir, { recursive: true });
  }
});
