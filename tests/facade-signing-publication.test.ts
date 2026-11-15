import { assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { fanoutSigningChange } from '#engine/server/device-federation.ts';

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
