import { assert, assertEquals, assertRejects } from '@std/assert';
import { type GatewayPolicy, sendGateway } from '#engine/push/transport.ts';

const policy = (): GatewayPolicy => ({
  blocklist: ['127.0.0.0/8', '10.0.0.0/8', '::1/128', '::ffff:0:0/96'],
  allowlist: [],
  caCerts: [],
  timeoutMs: 1000,
});

Deno.test('push transport: policy checks every resolved address and never follows redirects', async () => {
  let connections = 0;
  const deps = {
    resolve: () => Promise.resolve(['8.8.8.8', '127.0.0.1']),
    dial: () => {
      connections++;
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        body: new TextEncoder().encode('{"rejected":[]}'),
      });
    },
  };
  await assertRejects(() =>
    sendGateway(
      'https://gateway.test/_matrix/push/v1/notify',
      {},
      new AbortController().signal,
      policy(),
      deps,
    )
  );
  assertEquals(connections, 0);
  await assertRejects(() =>
    sendGateway(
      'https://gateway.test/_matrix/push/v1/notify',
      {},
      new AbortController().signal,
      policy(),
      {
        ...deps,
        resolve: () => Promise.resolve(['8.8.8.8']),
        dial: () => {
          connections++;
          return Promise.resolve({
            status: 307,
            headers: new Headers({
              location: 'https://127.0.0.1/_matrix/push/v1/notify',
            }),
            body: new Uint8Array(),
          });
        },
      },
    )
  );
  assertEquals(connections, 1);
});

Deno.test('push transport: bounded JSON, deadline/cancellation and required rejected verdict', async () => {
  const signal = new AbortController().signal;
  const url = 'https://gateway.test/_matrix/push/v1/notify';
  const p = policy();
  for (
    const body of ['{}', '{"rejected":false}', '{"rejected":[1]}', 'broken']
  ) {
    await assertRejects(() =>
      sendGateway(url, {}, signal, p, {
        resolve: () => Promise.resolve(['8.8.8.8']),
        dial: () =>
          Promise.resolve({
            status: 200,
            headers: new Headers(),
            body: new TextEncoder().encode(body),
          }),
      })
    );
  }
  await assertRejects(() =>
    sendGateway(url, { content: 'x'.repeat(262145) }, signal, p)
  );
  const started = Date.now();
  await assertRejects(() =>
    sendGateway(url, {}, signal, { ...p, timeoutMs: 25 }, {
      resolve: () => new Promise(() => {}),
      dial: () => {
        throw new Error('not reached');
      },
    })
  );
  assert(Date.now() - started < 500);
  const cancel = new AbortController();
  cancel.abort();
  await assertRejects(() => sendGateway(url, {}, cancel.signal, p));
});

Deno.test('push transport: real strict TLS accepts trusted peer and rejects CA/name/size errors', async () => {
  const cert = await Deno.readTextFile('tests/fixtures/tls/localhost.crt');
  const key = await Deno.readTextFile('tests/fixtures/tls/localhost.key');
  const ca = await Deno.readTextFile('tests/fixtures/tls/ca.crt');
  let count = 0;
  const peer = Deno.serve({
    hostname: '127.0.0.1',
    port: 0,
    cert,
    key,
    onListen() {},
  }, async (req) => {
    count++;
    assertEquals(req.method, 'POST');
    assertEquals(req.headers.get('authorization'), null);
    assertEquals(await req.json(), { notification: { counts: { unread: 0 } } });
    return Response.json({
      rejected: count === 2 ? ['key'] : [],
      padding: count === 3 ? 'x'.repeat(65537) : '',
    });
  });
  const port = (peer.addr as Deno.NetAddr).port;
  const p = { ...policy(), allowlist: ['127.0.0.1/32'], caCerts: [ca] };
  const payload = { notification: { counts: { unread: 0 } } };
  const url = `https://localhost:${port}/_matrix/push/v1/notify`;
  const deps = { resolve: () => Promise.resolve(['127.0.0.1']) };
  try {
    assertEquals(
      await sendGateway(url, payload, new AbortController().signal, p, deps),
      [],
    );
    assertEquals(
      await sendGateway(url, payload, new AbortController().signal, p, deps),
      ['key'],
    );
    await assertRejects(() =>
      sendGateway(url, payload, new AbortController().signal, p, deps)
    );
    await assertRejects(() =>
      sendGateway(url, payload, new AbortController().signal, {
        ...p,
        caCerts: [],
      }, deps)
    );
    await assertRejects(() =>
      sendGateway(
        `https://wrong.test:${port}/_matrix/push/v1/notify`,
        payload,
        new AbortController().signal,
        p,
        deps,
      )
    );
    assertEquals(
      count,
      3,
      'untrusted or wrong-name peers receive no HTTP request',
    );
  } finally {
    await peer.shutdown();
  }
});

Deno.test('push transport: abort closes the actual TLS socket while awaiting a gateway response', async () => {
  const cert = await Deno.readTextFile('tests/fixtures/tls/localhost.crt');
  const key = await Deno.readTextFile('tests/fixtures/tls/localhost.key');
  const ca = await Deno.readTextFile('tests/fixtures/tls/ca.crt');
  const listener = Deno.listenTls({
    hostname: '127.0.0.1',
    port: 0,
    cert,
    key,
  });
  const controller = new AbortController();
  let received!: () => void;
  const requestSeen = new Promise<void>((r) => {
    received = r;
  });
  const peer = (async () => {
    const conn = await listener.accept();
    try {
      const buffer = new Uint8Array(8192);
      assert((await conn.read(buffer))! > 0);
      received();
      while (await conn.read(buffer) !== null) {
        /* await actual socket close */
      }
    } catch (error) {
      // The socket owner destroys on abort. TCP reset and EOF both prove close.
      if (!(error instanceof Deno.errors.ConnectionReset)) throw error;
    } finally {
      conn.close();
    }
  })();
  const port = (listener.addr as Deno.NetAddr).port;
  const sending = sendGateway(
    `https://localhost:${port}/_matrix/push/v1/notify`,
    {},
    controller.signal,
    { ...policy(), caCerts: [ca], allowlist: ['127.0.0.1/32'] },
    { resolve: () => Promise.resolve(['127.0.0.1']) },
  );
  try {
    await requestSeen;
    controller.abort();
    await assertRejects(() => sending);
    await peer;
  } finally {
    listener.close();
  }
});
