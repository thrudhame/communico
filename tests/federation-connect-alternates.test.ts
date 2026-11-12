import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { dialNodeTls } from '#engine/federation/dial-node-tls.ts';
import { decodeJson } from '#engine/net/json.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { http1Request } from '#engine/net/http1.ts';

Deno.test('discovery alternates: plain redirect transport preserves caller cancellation', async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async () => {
      entered();
      await held;
      return new Response('late');
    },
  );
  const ac = new AbortController(),
    reason = new Error('caller redirect cancellation');
  const request = {
    connectIp: '127.0.0.1',
    port: server.addr.port,
    tls: null,
    hostHeader: 'localhost',
    method: 'GET',
    path: '/',
    headers: {},
    body: null,
    connectMs: 1000,
    timeoutMs: 3000,
    maxBytes: 1000,
    signal: ac.signal,
  };
  try {
    const pending = http1Request(request);
    await started;
    ac.abort(reason);
    assertEquals(await assertRejects(() => pending), reason);
  } finally {
    release();
    await server.shutdown();
  }
});

Deno.test('discovery alternates: connect failure may fail over before bytes; consuming replies and sink errors never replay', async () => {
  let first = 0, second = 0;
  const tls = {
    hostname: '127.0.0.1',
    port: 0,
    cert: await Deno.readTextFile('tests/fixtures/tls/localhost.crt'),
    key: await Deno.readTextFile('tests/fixtures/tls/localhost.key'),
    onListen() {},
  };
  const a = Deno.serve(tls, async (request) => {
    first++;
    await request.arrayBuffer();
    return new Response('malformed', {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const b = Deno.serve(tls, async (request) => {
    second++;
    await request.arrayBuffer();
    return Response.json({ one_time_keys: {} });
  });
  const opts = {
    connectIp: '127.0.0.2',
    port: b.addr.port,
    alternatives: [{ connectIp: '127.0.0.1', port: b.addr.port }],
    sni: 'localhost',
    hostHeader: 'localhost',
    trust: {
      kind: 'ca' as const,
      caCerts: [await Deno.readTextFile('tests/fixtures/tls/ca.crt')],
    },
    method: 'POST',
    path: '/_matrix/federation/v1/user/keys/claim',
    headers: {},
    body: new TextEncoder().encode('{}'),
    connectMs: 1000,
    timeoutMs: 3000,
    maxBytes: 10000,
  };
  try {
    const reply = await dialNodeTls(opts);
    assertEquals(decodeJson(reply.body, reply.headers.get('content-type')), {
      one_time_keys: {},
    });
    assertEquals([first, second], [0, 1]);
    const malformed = await dialNodeTls({
      ...opts,
      connectIp: '127.0.0.1',
      port: a.addr.port,
    });
    assertThrows(
      () => decodeJson(malformed.body, malformed.headers.get('content-type')),
      UpstreamError,
    );
    assertEquals([first, second], [1, 1]);
    const disk = new Error('local sink failure');
    assertEquals(
      await assertRejects(() =>
        dialNodeTls({
          ...opts,
          connectIp: '127.0.0.1',
          port: a.addr.port,
          sink: () =>
            new WritableStream({
              write() {
                throw disk;
              },
            }),
        })
      ),
      disk,
    );
    assertEquals([first, second], [2, 1]);
    // The peer receives the complete consuming request and closes without a
    // response. Even this ambiguous outcome must not visit the second address.
    const dropped = Deno.listenTls(tls);
    let consumed = false;
    const handling = (async () => {
      const conn = await dropped.accept();
      try {
        let request = '';
        const bytes = new Uint8Array(4096), decoder = new TextDecoder();
        while (!request.endsWith('\r\n\r\n{}')) {
          const n = await conn.read(bytes);
          if (n === null) throw new Error('request truncated before body');
          request += decoder.decode(bytes.subarray(0, n));
        }
        consumed = true;
      } finally {
        conn.close();
      }
    })();
    try {
      await assertRejects(
        () =>
          dialNodeTls({
            ...opts,
            connectIp: '127.0.0.1',
            port: dropped.addr.port,
          }),
        UpstreamError,
      );
      await handling;
      assertEquals(consumed, true);
      assertEquals([first, second], [2, 1]);
    } finally {
      dropped.close();
    }
  } finally {
    await a.shutdown();
    await b.shutdown();
  }
});
