import { assertEquals, assertRejects } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import {
  FederationHttpError,
  federationRequest,
  resetCaCertsForTests,
} from '#engine/federation/client.ts';
import {
  listOutbox,
  peerStatus,
  startSender,
} from '#engine/federation/sender.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { resolveWith } from '#engine/federation/resolve.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { type FakeServer, startFakeServer } from './federation/fake-server.ts';
import { testRemoteServer, testSigner } from './fixtures/signer.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
} from '#engine/signing-primitives.js';

async function withPeer(
  reply: () => Response,
  run: (store: Store, fake: FakeServer) => Promise<void>,
) {
  const previous = config();
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  const dir = await Deno.makeTempDir({ prefix: 'response-boundary-' });
  const store = await openStore({
    ...config().store,
    dir,
    library: './.native/libturso_ffi.so',
  }, { schemas: { server: serverSchema } });
  const us = await testRemoteServer('test');
  const key = b64encodeStd(await exportPublicKeyRaw(us.kp.publicKey));
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: us.name,
        verify_keys: { [us.keyId]: { key } },
      }),
    handlers: (req) =>
      req.path.startsWith('/_matrix/federation/v1/send/') ||
        req.path === '/reply'
        ? reply()
        : null,
  });
  try {
    await run(store, fake);
  } finally {
    await fake.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
    setConfigForTests(previous);
    resetCaCertsForTests();
  }
}

Deno.test('federation taxonomy: no DNS address is transport, not local signer/storage failure', async () => {
  const error = await assertRejects(() =>
    resolveWith('missing.test:8448', {
      dnsA: () => Promise.resolve([]),
      dnsAAAA: () => Promise.resolve([]),
      dnsSrv: () => Promise.resolve([]),
      wellKnownGet: () => Promise.resolve({ mServer: null, maxAgeMs: null }),
      lookupPeer: () => Promise.resolve(null),
    }), UpstreamError);
  assertEquals(error.category, 'transport');
  assertEquals(error.context.phase, 'dns');
});

Deno.test('federation JSON: Matrix error message is optional, omitted and null preserve completed HTTP provenance', async () => {
  for (const message of [undefined, null]) {
    await withPeer(
      () =>
        Response.json({ errcode: 'M_UNRECOGNIZED', error: message }, {
          status: 404,
        }),
      async (store, fake) => {
        const server = await store.server(), signer = await testSigner('test');
        const error = await assertRejects(
          () =>
            federationRequest(server, signer, {
              destination: fake.name,
              method: 'GET',
              path: '/reply',
              body: null,
            }),
          FederationHttpError,
        );
        assertEquals(error.remoteStatus, 404);
        assertEquals(error.matrixBody, true);
        assertEquals(error.status, 404);
        assertEquals(error.errcode, 'M_UNRECOGNIZED');
      },
    );
  }
});

Deno.test('federation JSON: malformed success is protocol, never null or completed HTTP refusal', async (t) => {
  for (
    const [name, reply] of [
      [
        'empty',
        () =>
          new Response('', { headers: { 'Content-Type': 'application/json' } }),
      ],
      [
        'invalid-json',
        () =>
          new Response('{', {
            headers: { 'Content-Type': 'application/json' },
          }),
      ],
      [
        'invalid-utf8',
        () =>
          new Response(
            new Uint8Array([123, 34, 97, 34, 58, 34, 255, 34, 125]),
            {
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      ],
      [
        'wrong-media-type',
        () => new Response('{}', { headers: { 'Content-Type': 'text/plain' } }),
      ],
    ] as const
  ) {
    await t.step(name, () =>
      withPeer(reply, async (store, fake) => {
        const server = await store.server(), signer = await testSigner('test');
        const result = await assertRejects(() =>
          federationRequest(server, signer, {
            destination: fake.name,
            method: 'GET',
            path: '/reply',
            body: null,
          }), UpstreamError);
        assertEquals(result.category, 'protocol');
      }));
  }
});

Deno.test('sender: malformed 2xx cannot acknowledge durable delivery and restart retries the frozen transaction', async (t) => {
  for (
    const [name, bad] of [
      [
        'invalid-json',
        () =>
          new Response('{', {
            headers: { 'Content-Type': 'application/json' },
          }),
      ],
      ['null', () => Response.json(null)],
      ['missing-map', () => Response.json({})],
      ['array-map', () => Response.json({ pdus: [] })],
      ['null-verdict', () => Response.json({ pdus: { $e: null } })],
      ['wrong-error', () => Response.json({ pdus: { $e: { error: 2 } } })],
    ] as const
  ) {
    await t.step(name, async () => {
      let valid = false;
      let received!: () => void;
      const answered = new Promise<void>((resolve) => received = resolve);
      await withPeer(() => {
        received();
        return valid ? Response.json({ pdus: {} }) : bad();
      }, async (store, fake) => {
        const server = await store.server();
        const signer = await testSigner('test');
        await server.execute(
          'INSERT INTO feed(seq,room,pos,event,stay) VALUES(1,?,?,?,1)',
          ['!missing:test', 1, '$e'],
        );
        await server.execute(
          "INSERT INTO outbox(room,pos,destination,event,state,added_ms) VALUES(?,?,?,?,'pending',?)",
          ['!missing:test', 1, fake.name, '$e', Date.now()],
        );
        let sender = startSender({ store, signer });
        try {
          await answered;
          await sender.stop();
          assertEquals((await listOutbox(server))[0].state, 'pending');
          assertEquals(
            (await peerStatus(server, fake.name)).lastSuccessMs,
            null,
          );
          const first = fake.requests.find((r) =>
            r.path.includes('/send/')
          )!.path;
          await server.execute('UPDATE outbox SET next_attempt_ms=0');
          await server.execute('UPDATE peer_status SET next_attempt_ms=0');
          valid = true;
          let delivered!: () => void;
          const done = new Promise<void>((resolve) => delivered = resolve);
          sender = startSender({
            store,
            signer,
            onDelivered: () => {
              delivered();
              return Promise.resolve();
            },
          });
          await done;
          await sender.stop();
          assertEquals((await listOutbox(server))[0].state, 'sent');
          const sends = fake.requests.filter((r) => r.path.includes('/send/'));
          assertEquals(sends.length, 2);
          assertEquals(sends[1].path, first);
        } finally {
          await sender.stop();
        }
      });
    });
  }
});

Deno.test('sender: a local signing fault does not publish peer failure or delivery', async () => {
  await withPeer(() => Response.json({ pdus: {} }), async (store, fake) => {
    const server = await store.server(), real = await testSigner('test');
    await server.execute(
      'INSERT INTO feed(seq,room,pos,event,stay) VALUES(1,?,?,?,1)',
      ['!missing:test', 1, '$e'],
    );
    await server.execute(
      "INSERT INTO outbox(room,pos,destination,event,state,added_ms) VALUES(?,?,?,?,'pending',?)",
      ['!missing:test', 1, fake.name, '$e', Date.now()],
    );
    let attempted!: () => void;
    const signed = new Promise<void>((resolve) => attempted = resolve);
    const fault = new Error('injected local signer failure');
    const sender = startSender({
      store,
      signer: {
        ...real,
        sign() {
          attempted();
          return Promise.reject(fault);
        },
      },
    });
    try {
      await signed;
      await sender.stop();
      const row = (await listOutbox(server))[0];
      assertEquals(row.state, 'pending');
      assertEquals(row.attempts, 0);
      const status = await peerStatus(server, fake.name);
      assertEquals(status.lastSuccessMs, null);
      assertEquals(status.failures, 0);
      assertEquals(status.attemptsTotal, 0);
      assertEquals(fake.requests.length, 0);
    } finally {
      await sender.stop();
    }
  });
});

Deno.test('sender: a valid per-PDU error is a handled transaction, not transport refusal', async () => {
  await withPeer(
    () => Response.json({ pdus: { $e: { error: 'event rejected' } } }),
    async (store, fake) => {
      const server = await store.server(), signer = await testSigner('test');
      await server.execute(
        'INSERT INTO feed(seq,room,pos,event,stay) VALUES(1,?,?,?,1)',
        ['!missing:test', 1, '$e'],
      );
      await server.execute(
        "INSERT INTO outbox(room,pos,destination,event,state,added_ms) VALUES(?,?,?,?,'pending',?)",
        ['!missing:test', 1, fake.name, '$e', Date.now()],
      );
      let delivered!: () => void;
      const done = new Promise<void>((resolve) => delivered = resolve);
      const sender = startSender({
        store,
        signer,
        onDelivered: () => {
          delivered();
          return Promise.resolve();
        },
      });
      try {
        await done;
        await sender.stop();
        assertEquals((await listOutbox(server))[0].state, 'sent');
        const status = await peerStatus(server, fake.name);
        assertEquals(status.failures, 0);
        assertEquals(status.attemptsTotal, 1);
        assertEquals(status.lastSuccessMs !== null, true);
      } finally {
        await sender.stop();
      }
    },
  );
});
