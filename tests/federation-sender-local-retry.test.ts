import { assert, assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { peerStatus, startSender } from '#engine/federation/sender.ts';
import { frozenBatch } from '#engine/server/delivery.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { startFakeServer } from './federation/fake-server.ts';
import { randomSigner } from './fixtures/signer.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
} from '#engine/signing-primitives.js';

async function waitFor(ready: () => Promise<boolean>) {
  const until = Date.now() + 5000;
  while (!await ready()) {
    assert(Date.now() < until, 'local retry stranded durable delivery');
    await new Promise((r) => setTimeout(r, 10));
  }
}

for (const family of ['batch', 'intent']) {
  Deno.test(
    'sender local retry: ' + family +
      ' eventually delivers without peer failure or producer wake',
    async () => {
      const dir = await Deno.makeTempDir();
      const store = await openStore({
        dir,
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
        maxopenfiles: 8,
        idleseconds: 300,
      }, { schemas: { server: serverSchema } });
      setConfigForTests({
        federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
      });
      resetCaCertsForTests();
      const { signer, publicKey } = await randomSigner('test');
      const key = b64encodeStd(await exportPublicKeyRaw(publicKey));
      const fake = await startFakeServer({
        ourKeyDoc: () =>
          Promise.resolve({
            server_name: signer.serverName,
            verify_keys: { [signer.keyId]: { key } },
          }),
        handlers: () => Response.json({ pdus: {} }),
      });
      const db = await store.server();
      let sender: ReturnType<typeof startSender> | undefined;
      let attempted = false,
        recovered = false,
        finished = false,
        failedIntents = 0;
      try {
        if (family === 'batch') {
          await db.execute(
            "INSERT INTO edu_outbox VALUES('local-retry',?,'m.test','{}','pending',?)",
            [fake.name, Date.now()],
          );
        }
        sender = startSender({
          store,
          signer: {
            ...signer,
            sign: (bytes) => {
              attempted = true;
              if (!recovered) {
                throw new Error('local signer temporarily unavailable');
              }
              return signer.sign(bytes);
            },
          },
        });
        if (family === 'intent') {
          sender.setIntentProvider(() =>
            Promise.resolve(
              finished ? null : {
                id: 'local-intent',
                run: () => {
                  attempted = true;
                  if (!recovered) {
                    throw new Error('local intent signer unavailable');
                  }
                  finished = true;
                  return Promise.resolve();
                },
                failed: () => {
                  failedIntents++;
                  return Promise.resolve();
                },
              },
            )
          );
          sender.wake(fake.name);
        }
        await waitFor(() => Promise.resolve(attempted));
        // The worker must recover by itself, not by receiving unrelated new work.
        await new Promise((r) => setTimeout(r, 30));
        const frozen = await frozenBatch(db, fake.name);
        recovered = true;
        await waitFor(async () =>
          family === 'intent' ? finished : (await db.query(
            "SELECT source FROM edu_outbox WHERE state='pending'",
          )).length === 0
        );
        assertEquals(
          failedIntents,
          0,
          'local fault cannot advance an intent candidate',
        );
        assertEquals((await peerStatus(db, fake.name)).failuresTotal, 0);
        if (family === 'batch') {
          assert(
            frozen,
            'the exact batch must remain frozen during local failure',
          );
          assertEquals(
            new TextDecoder().decode(fake.requests.at(-1)!.body!),
            frozen.body,
          );
          assert(fake.requests.at(-1)!.path.endsWith('/' + frozen.txnId));
          assertEquals(await frozenBatch(db, fake.name), null);
          assertEquals((await peerStatus(db, fake.name)).attemptsTotal, 1);
        }
      } finally {
        await sender?.stop();
        await fake.close();
        await store.close();
        await Deno.remove(dir, { recursive: true });
        setConfigForTests({});
        resetCaCertsForTests();
      }
    },
  );
}
