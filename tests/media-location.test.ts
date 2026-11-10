import { assertEquals, assertRejects } from '@std/assert';
import { fetchLocation, type LocationPolicy } from '#engine/media/location.ts';
import type { DialOpts } from '#engine/federation/dial-node-tls.ts';

const policy: LocationPolicy = {
  maxBytes: 100,
  timeoutMs: 300,
  maxRedirects: 2,
  blocklist: ['127.0.0.0/8', '10.0.0.0/8', '::/128'],
  allowlist: [],
  caCerts: ['test-root'],
};
const signal = () => new AbortController().signal;
const sink = () => new WritableStream<Uint8Array>();
const resolve = () => Promise.resolve(['1.2.3.4']);
function dialer(
  responses: { status: number; location?: string; body?: string }[],
  calls: DialOpts[],
) {
  return async (opts: DialOpts) => {
    calls.push(opts);
    const next = responses.shift()!;
    const headers = new Headers({ 'Content-Type': 'image/png' });
    if (next.location) headers.set('Location', next.location);
    const writer = opts.sink!(next.status, headers)!.getWriter();
    try {
      await writer.write(new TextEncoder().encode(next.body ?? ''));
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => {});
      throw error;
    }
    return { status: next.status, headers, body: new Uint8Array() };
  };
}
Deno.test('media Location: CA-only identity-pinned HTTPS sends no authentication across redirects', async () => {
  const calls: DialOpts[] = [];
  const chunks: Uint8Array[] = [];
  const result = await fetchLocation(
    'https://origin.example/a',
    new WritableStream({
      write(c) {
        chunks.push(c);
      },
    }),
    signal(),
    policy,
    {
      resolve,
      dial: dialer([{
        status: 302,
        location: 'https://cdn.example/bytes?secret=1',
      }, { status: 200, body: 'image' }], calls),
    },
  );
  assertEquals(result.size, 5);
  assertEquals(new TextDecoder().decode(chunks[0]), 'image');
  assertEquals(calls.map((c) => c.connectIp), ['1.2.3.4', '1.2.3.4']);
  assertEquals(calls.map((c) => c.sni), ['origin.example', 'cdn.example']);
  for (const call of calls) {
    assertEquals(call.headers, { Accept: '*/*' });
    assertEquals(call.trust, { kind: 'ca', caCerts: ['test-root'] });
  }
  assertEquals('url' in result, false);
});
Deno.test('media Location: all resolved addresses screened before any dial; explicit private allowlist wins', async () => {
  const calls: DialOpts[] = [];
  const deps = {
    resolve: () => Promise.resolve(['1.2.3.4', '127.0.0.1']),
    dial: dialer([{ status: 200 }], calls),
  };
  await assertRejects(() =>
    fetchLocation('https://cdn.example/x', sink(), signal(), policy, deps)
  );
  assertEquals(calls.length, 0);
  await fetchLocation('https://cdn.example/x', sink(), signal(), {
    ...policy,
    allowlist: ['127.0.0.1/32'],
  }, deps);
  assertEquals(calls.length, 1);
});
Deno.test('media Location: HTTP, credentials, fragments, redirect-private and malformed IPs refused', async () => {
  for (
    const url of [
      'http://a/x',
      'https://user:pw@a/x',
      'https://a/x#fragment',
      'data:text/plain,x',
    ]
  ) {
    const calls: DialOpts[] = [];
    await assertRejects(() =>
      fetchLocation(url, sink(), signal(), policy, {
        resolve,
        dial: dialer([{ status: 200 }], calls),
      })
    );
    assertEquals(calls.length, 0);
  }
  const calls: DialOpts[] = [];
  await assertRejects(() =>
    fetchLocation('https://cdn.example/x', sink(), signal(), policy, {
      resolve: (host) =>
        Promise.resolve([host === 'cdn.example' ? '1.2.3.4' : '127.0.0.1']),
      dial: dialer(
        [{ status: 302, location: 'https://private.example/x' }],
        calls,
      ),
    })
  );
  assertEquals(calls.length, 1);
});
Deno.test('media Location: hop cap and total byte budget apply across redirects', async () => {
  const calls: DialOpts[] = [];
  await assertRejects(() =>
    fetchLocation('https://cdn.example/x', sink(), signal(), {
      ...policy,
      maxBytes: 5,
    }, {
      resolve,
      dial: dialer([{ status: 302, location: '/a', body: '123' }, {
        status: 200,
        body: '456',
      }], calls),
    })
  );
  assertEquals(calls[1].maxBytes, 2);
  const more: DialOpts[] = [];
  await assertRejects(() =>
    fetchLocation('https://cdn.example/x', sink(), signal(), {
      ...policy,
      maxRedirects: 1,
    }, {
      resolve,
      dial: dialer([{ status: 302, location: '/a' }, {
        status: 302,
        location: '/b',
      }], more),
    })
  );
  assertEquals(more.length, 2);
});
Deno.test('media Location: total cancellation covers DNS without a late dial', async () => {
  const calls: DialOpts[] = [];
  await assertRejects(() =>
    fetchLocation('https://cdn.example/x', sink(), signal(), {
      ...policy,
      timeoutMs: 20,
    }, {
      resolve: () => new Promise(() => {}),
      dial: dialer([{ status: 200 }], calls),
    })
  );
  assertEquals(calls.length, 0);
});

Deno.test('media Location: real TLS streams CDN bytes, checks CA/name, rejects redirect to private and closes on cancellation', async () => {
  const seen: Headers[] = [];
  let cancelled = false;
  const server = Deno.serve({
    hostname: '127.0.0.1',
    port: 0,
    cert: await Deno.readTextFile('tests/fixtures/tls/localhost.crt'),
    key: await Deno.readTextFile('tests/fixtures/tls/localhost.key'),
    onListen() {},
  }, (req) => {
    seen.push(req.headers);
    const path = new URL(req.url).pathname;
    if (path === '/redirect') {
      return new Response(null, {
        status: 302,
        headers: { Location: '/bytes' },
      });
    }
    if (path === '/stall') {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    }
    return new Response(new Uint8Array(100000).fill(47), {
      headers: { 'Content-Type': 'image/png' },
    });
  });
  const root = `https://localhost:${server.addr.port}`;
  const tls = {
    ...policy,
    maxBytes: 100000,
    timeoutMs: 1000,
    allowlist: ['127.0.0.1/32'],
    caCerts: [await Deno.readTextFile('tests/fixtures/tls/ca.crt')],
  };
  try {
    let size = 0;
    const result = await fetchLocation(
      root + '/redirect',
      new WritableStream({
        write(c) {
          assertEquals(c.every((x) => x === 47), true);
          size += c.length;
        },
      }),
      signal(),
      tls,
      { resolve: () => Promise.resolve(['127.0.0.1']) },
    );
    assertEquals(size, 100000);
    assertEquals(result.size, size);
    assertEquals(seen.length, 2);
    for (const headers of seen) {
      assertEquals(headers.has('authorization'), false);
      assertEquals(headers.has('cookie'), false);
    }
    await assertRejects(() =>
      fetchLocation(
        root + '/bytes',
        sink(),
        signal(),
        { ...tls, caCerts: [] },
        { resolve: () => Promise.resolve(['127.0.0.1']) },
      )
    );
    await assertRejects(() =>
      fetchLocation(
        `https://wrong.example:${server.addr.port}/bytes`,
        sink(),
        signal(),
        tls,
        { resolve: () => Promise.resolve(['127.0.0.1']) },
      )
    );
    const before = seen.length;
    await assertRejects(() =>
      fetchLocation(root + '/redirect', sink(), signal(), {
        ...tls,
        allowlist: [],
      }, { resolve: () => Promise.resolve(['127.0.0.1']) })
    );
    assertEquals(seen.length, before);
    await assertRejects(() =>
      fetchLocation(root + '/stall', sink(), signal(), {
        ...tls,
        timeoutMs: 30,
      }, { resolve: () => Promise.resolve(['127.0.0.1']) })
    );
    for (let i = 0; i < 30 && !cancelled; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(cancelled, true);
  } finally {
    await server.shutdown();
    await server.finished;
  }
});
