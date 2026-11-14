import { assert, assertEquals, assertRejects } from '@std/assert';
import { request } from 'node:https';
import { LinkError } from '#engine/facade/protocol.ts';
import {
  LinkClient,
  loadLinkTls,
  startLinkTransport,
} from '#engine/facade/transport.ts';
import { facadeTls } from './support/facade-tls.ts';

Deno.test('production mTLS authenticates both pins before application admission', async (t) => {
  const f = await facadeTls();
  let expected = f.homePin;
  let admitted = 0;
  const server = await startLinkTransport({
    hostname: '127.0.0.1',
    port: 0,
    tls: f.facade,
    authorize: (pin) => Promise.resolve(pin === expected),
    handle: async (req, peerPin) => {
      admitted++;
      assertEquals(peerPin, expected);
      return Response.json({
        body: await req.json(),
        path: new URL(req.url).pathname,
      });
    },
  });
  const client = new LinkClient(f.home, { url: server.url, pin: f.facadePin });
  try {
    await t.step(
      'valid identities transfer the exact request and response',
      async () => {
        const response = await client.fetch('/_communico/link/v1/enroll', {
          method: 'POST',
          body: JSON.stringify({ secret: 'not-a-bearer' }),
        });
        assertEquals(response.status, 200);
        assertEquals(await response.json(), {
          body: { secret: 'not-a-bearer' },
          path: '/_communico/link/v1/enroll',
        });
        assertEquals(admitted, 1);
      },
    );
    await t.step(
      'wrong facade pin sends no HTTP request or enrollment secret',
      async () => {
        const wrong = new LinkClient(f.home, {
          url: server.url,
          pin: f.wrongPin,
        });
        await assertRejects(() =>
          wrong.fetch('/_communico/link/v1/enroll', {
            method: 'POST',
            body: 'private enrollment credential',
          })
        );
        assertEquals(admitted, 1);
      },
    );
    await t.step(
      'wrong CA and hostname cannot be replaced by the right pin',
      async () => {
        const untrusted = new LinkClient({ ...f.home, ca: [f.wrong.cert] }, {
          url: server.url,
          pin: f.facadePin,
        });
        await assertRejects(() => untrusted.fetch('/_communico/link/v1/hello'));
        const misnamed = await startLinkTransport({
          hostname: '127.0.0.1',
          port: 0,
          tls: f.wrong,
          authorize: () => Promise.resolve(true),
          handle: () => {
            admitted++;
            return Promise.resolve(Response.json({}));
          },
        });
        try {
          const mismatch = new LinkClient(f.home, {
            url: misnamed.url,
            pin: f.wrongPin,
          });
          await assertRejects(() =>
            mismatch.fetch('/_communico/link/v1/hello')
          );
        } finally {
          await misnamed.close();
        }
        assertEquals(admitted, 1);
      },
    );
    await t.step(
      'wrong home pin is refused without invoking or reading the handler',
      async () => {
        const wrong = new LinkClient(f.wrong, {
          url: server.url,
          pin: f.facadePin,
        });
        const response = await wrong.fetch('/_communico/link/v1/enroll', {
          method: 'POST',
          body: 'private',
        });
        assertEquals(response.status, 403);
        await response.body?.cancel();
        assertEquals(admitted, 1);
      },
    );
    await t.step(
      'a missing client certificate never reaches application admission',
      async () => {
        await assertRejects(() =>
          new Promise<void>((resolve, reject) => {
            const req = request(server.url + '/_communico/link/v1/hello', {
              ca: f.home.ca,
              agent: false,
            }, (res) => {
              res.resume();
              resolve();
            });
            req.on('error', reject);
            req.on('close', resolve);
            req.end();
          })
        );
        assertEquals(admitted, 1);
      },
    );
    await t.step('dynamic authority is rechecked on each request', async () => {
      expected = f.wrongPin;
      const response = await client.fetch('/_communico/link/v1/hello');
      assertEquals(response.status, 403);
      await response.body?.cancel();
      assertEquals(admitted, 1);
    });
    await t.step(
      'an already aborted call sends no application bytes',
      async () => {
        await assertRejects(() =>
          client.fetch('/_communico/link/v1/hello', {
            signal: AbortSignal.abort(),
          })
        );
        assertEquals(admitted, 1);
      },
    );
    await t.step('the peer cannot be replaced through a path', async () => {
      await assertRejects(() => client.fetch('https://other.test/'), LinkError);
      await assertRejects(
        () => client.fetch('/_matrix/key/v2/server'),
        LinkError,
      );
      assertEquals(admitted, 1);
    });
  } finally {
    await server.close();
    await f.close();
  }
});

Deno.test('link TLS loader enforces local private-key ownership and permissions', async () => {
  const f = await facadeTls();
  const files = {
    linkcert: f.dir + '/home.crt',
    linkkey: f.dir + '/home.key',
    linkcacerts: [f.dir + '/ca.crt'],
  };
  try {
    assertEquals(await loadLinkTls(files), f.home);
    await Deno.chmod(files.linkkey, 0o644);
    await assertRejects(() => loadLinkTls(files), LinkError);
    await Deno.chmod(files.linkkey, 0o600);
    await Deno.symlink(files.linkkey, f.dir + '/alias');
    await assertRejects(
      () => loadLinkTls({ ...files, linkkey: f.dir + '/alias' }),
      LinkError,
    );
    assert(f.home.key.includes('PRIVATE KEY'));
  } finally {
    await f.close();
  }
});

Deno.test('link shutdown aborts transport but drains admitted domain work', async () => {
  const f = await facadeTls();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let finished = false;
  let signal: AbortSignal | undefined;
  const server = await startLinkTransport({
    hostname: '127.0.0.1',
    port: 0,
    tls: f.facade,
    authorize: () => Promise.resolve(true),
    handle: async (req) => {
      signal = req.signal;
      entered.resolve();
      await release.promise;
      finished = true;
      return Response.json({ durable: true });
    },
  });
  const client = new LinkClient(f.home, { url: server.url, pin: f.facadePin });
  const result = client.fetch('/_communico/link/v1/hello').then(async (r) => {
    await r.body?.cancel();
  }).catch(() => {});
  try {
    await entered.promise;
    const closing = server.close();
    assert(signal?.aborted);
    assert(!finished);
    release.resolve();
    await closing;
    assert(finished);
    await result;
    await server.close();
  } finally {
    release.resolve();
    await server.close();
    await result;
    await f.close();
  }
});

Deno.test('link shutdown cancels incomplete authenticated uploads', async () => {
  const f = await facadeTls();
  const admitted = Promise.withResolvers<void>();
  let handled = false;
  const server = await startLinkTransport({
    hostname: '127.0.0.1',
    port: 0,
    tls: f.facade,
    authorize: () => {
      admitted.resolve();
      return Promise.resolve(true);
    },
    handle: () => {
      handled = true;
      return Promise.resolve(Response.json({}));
    },
  });
  const req = request(server.url + '/_communico/link/v1/records', {
    ...f.home,
    method: 'POST',
    agent: false,
    headers: { 'content-length': '1000000' },
  });
  req.on('error', () => {});
  req.on('response', (res) => res.resume());
  req.write('unfinished');
  try {
    await admitted.promise;
    // Test deadline only: the production transport must not need a timeout to
    // interrupt a half-upload during shutdown.
    await Promise.race([
      server.close(),
      new Promise<never>((_, reject) => {
        const signal = AbortSignal.timeout(1000);
        signal.addEventListener(
          'abort',
          () => reject(new Error('upload blocked shutdown')),
          { once: true },
        );
      }),
    ]);
    assert(!handled);
  } finally {
    req.destroy();
    await server.close();
    await f.close();
  }
});
