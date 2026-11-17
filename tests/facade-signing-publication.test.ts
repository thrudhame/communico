import { assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import {
  fanoutDeviceChange,
  fanoutSigningChange,
} from '#engine/server/device-federation.ts';

Deno.test('F2 signing publication sends only master/self-signing keys from a complete private intent', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'signing-publication-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  try {
    const server = await store.server();
    await server.tx(async (conn) => {
      await conn.execute(
        'INSERT INTO device_subscriptions VALUES(?,?,1,1,0,NULL)',
        [
          '@alice:logical.test',
          'remote.test',
        ],
      );
      await fanoutSigningChange(conn, '@alice:logical.test', 1, {
        kind: 'public_signing',
        subject: '@alice:logical.test',
        master_key: { public: 'master' },
        self_signing_key: { public: 'self' },
        user_signing_key: { public: 'own-user-only' },
        signingOperation: { keys: ['master', 'self', 'own-user-only'] },
      });
    });
    assertEquals(
      JSON.parse(
        String(
          (await server.query('SELECT payload FROM public_signing_keys'))[0]
            .payload,
        ),
      ),
      {
        master_key: { public: 'master' },
        self_signing_key: { public: 'self' },
      },
    );
    assertEquals(
      JSON.parse(
        String(
          (await server.query('SELECT payload FROM edu_outbox'))[0].payload,
        ),
      ),
      {
        user_id: '@alice:logical.test',
        master_key: { public: 'master' },
        self_signing_key: { public: 'self' },
      },
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('F2 device publication allowlists the public wire view, not portable signature intent or future semantic fields', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'device-publication-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  try {
    const server = await store.server();
    await server.tx(async (conn) => {
      await conn.execute(
        'INSERT INTO device_subscriptions VALUES(?,?,1,1,0,NULL)',
        ['@alice:logical.test', 'remote.test'],
      );
      await fanoutDeviceChange(
        conn,
        '@alice:logical.test',
        1,
        JSON.stringify({
          device_id: 'LAN',
          generation: 7,
          device_display_name: 'LAN device',
          keys: { public: 'device key' },
          operation: { original: 'owner device intent' },
          signatureOperation: {
            private: 'own-user target and signer evidence',
          },
          futureSemanticField: 'not public wire authority',
        }),
      );
    });
    assertEquals(
      JSON.parse(
        String(
          (await server.query('SELECT payload FROM edu_outbox'))[0].payload,
        ),
      ),
      {
        user_id: '@alice:logical.test',
        device_id: 'LAN',
        device_display_name: 'LAN device',
        keys: { public: 'device key' },
        stream_id: 1,
        prev_id: [0],
      },
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
