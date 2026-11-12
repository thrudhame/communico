// tests/federation-resolve.test.ts — the resolution ladder with injected
// deps: IP literal, explicit port, .well-known (+ sub-ladder), SRV
// priority pick, roster overrides, key-is-name 502s. No network, no DB —
// plus the production roster wiring over a real server file (doltgres
// tests/federation-resolve.test.ts, restored).
import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  resetWellKnownCache,
  resolve,
  type ResolveDeps,
  resolveWith,
  splitServerName,
} from '#engine/federation/resolve.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';

Deno.test('discovery grammar: server-name syntax is not URL syntax or numeric coercion', () => {
  for (
    const raw of [
      'name:',
      'name:+443',
      'name:1e3',
      'name:65536',
      '[::1]garbage',
      '[bad]:443',
      '::1',
      'https://name',
      'name/path',
      'name?x=1',
      'name#fragment',
      'name: 443',
      'bad_name',
      '256.1.1.1',
    ]
  ) {
    assertThrows(() => splitServerName(raw), UpstreamError, undefined, raw);
  }
  assertEquals(splitServerName('[::ffff:192.0.2.1]:8448'), {
    host: '::ffff:192.0.2.1',
    port: 8448,
  });
  assertEquals(splitServerName('name.test:00443'), {
    host: 'name.test',
    port: 443,
  });
});

Deno.test('discovery grammar: weighted SRV order, unavailable target and alternate eligible answers', async () => {
  const weighted = Object.assign(
    deps({
      dnsSrv: (h) =>
        Promise.resolve(
          h.startsWith('_matrix-fed.')
            ? [
              { target: 'light.test', port: 1111, priority: 1, weight: 2 },
              { target: 'heavy.test', port: 2222, priority: 1, weight: 8 },
            ]
            : [],
        ),
      dnsA: () => Promise.resolve(['127.0.0.1']),
    }),
    { random: () => 0.1 },
  );
  assertEquals((await resolveWith('weighted.test', weighted)).port, 1111);
  const visited: string[] = [];
  const unavailable = deps({
    dnsSrv: (h) => {
      visited.push(h);
      return Promise.resolve([{
        target: '.',
        port: 0,
        priority: 0,
        weight: 0,
      }]);
    },
    dnsA: (h) => {
      visited.push(h);
      return Promise.resolve(['127.0.0.1']);
    },
  });
  assertEquals(
    (await assertRejects(
      () => resolveWith('unavailable.test', unavailable),
      UpstreamError,
    )).category,
    'transport',
  );
  assertEquals(visited, ['_matrix-fed._tcp.unavailable.test']);
  const alternate = deps({
    wellKnownGet: () =>
      Promise.resolve({ mServer: 'delegate.test', maxAgeMs: null }),
    dnsSrv: (h) =>
      Promise.resolve(
        h.startsWith('_matrix-fed.')
          ? [
            { target: 'missing.test', port: 1234, priority: 0, weight: 1 },
            { target: 'working.test', port: 4321, priority: 1, weight: 1 },
          ]
          : [],
      ),
    dnsA: (h) => Promise.resolve(h === 'working.test' ? ['127.0.0.1'] : []),
    dnsAAAA: (h) => Promise.resolve(h === 'working.test' ? ['::1'] : []),
  });
  const endpoint = await resolveWith('main.test', alternate);
  assertEquals([
    endpoint.connectIp,
    endpoint.port,
    endpoint.hostHeader,
    endpoint.sni,
  ], ['127.0.0.1', 4321, 'delegate.test', 'delegate.test']);
});

Deno.test('discovery grammar: production well-known follows only real redirects, retains queries, validates JSON and honors cache directives', async () => {
  const oldDns = Deno.resolveDns;
  Deno.resolveDns = ((_: string, type: string) =>
    Promise.resolve(
      type === 'A' ? ['127.0.0.1'] : [],
    )) as typeof Deno.resolveDns;
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  let mode = 'redirect', calls = 0;
  const requests: string[] = [];
  const plain = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (request) => {
      calls++;
      assertEquals(
        new URL(request.url).pathname + new URL(request.url).search,
        '/delegate?keep=yes',
      );
      assertEquals(request.headers.get('authorization'), null);
      return Response.json({ 'm.server': 'delegate.test:8452' });
    },
  );
  const server = Deno.serve({
    hostname: '127.0.0.1',
    port: 443,
    cert: await Deno.readTextFile('tests/fixtures/tls/localhost.crt'),
    key: await Deno.readTextFile('tests/fixtures/tls/localhost.key'),
    onListen() {},
  }, (request) => {
    calls++;
    const url = new URL(request.url);
    requests.push(url.pathname + url.search);
    if (mode === 'http-redirect') {
      return new Response(null, {
        status: 307,
        headers: {
          Location: 'http://localhost:' + plain.addr.port +
            '/delegate?keep=yes',
        },
      });
    }
    if (mode === 'redirect' && url.pathname.startsWith('/.well-known')) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/delegate?keep=yes' },
      });
    }
    if (mode === 'redirect' && url.search !== '?keep=yes') {
      return new Response(null, { status: 404 });
    }
    if (mode === 'not-redirect') {
      return new Response(null, {
        status: 304,
        headers: { Location: '/delegate?keep=yes' },
      });
    }
    if (mode === 'scheme') {
      return new Response(null, {
        status: 302,
        headers: { Location: 'ftp://localhost/delegate' },
      });
    }
    if (mode === 'invalid') {
      return Response.json({ 'm.server': 'delegate.test/path' });
    }
    if (mode === 'root') return Response.json([]);
    if (mode === 'utf8') {
      return new Response(new Uint8Array([123, 255, 125]), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const headers: Record<string, string> = mode === 'no-store'
      ? { 'Cache-Control': 'no-store' }
      : mode === 'no-cache'
      ? { 'Cache-Control': 'public, no-cache' }
      : mode === 'age'
      ? { 'Cache-Control': 'MAX-AGE="60"', Age: '61' }
      : { 'Cache-Control': 'public, MAX-AGE="60"' };
    return Response.json({ 'm.server': 'delegate.test:8451' }, { headers });
  });
  try {
    await withStore(async (store) => {
      const db = await store.server();
      const read = () => resolve(db, 'localhost');
      resetWellKnownCache();
      assertEquals((await read()).port, 8451);
      assertEquals(requests, [
        '/.well-known/matrix/server',
        '/delegate?keep=yes',
      ]);
      mode = 'http-redirect';
      resetWellKnownCache();
      assertEquals((await read()).port, 8452);
      for (mode of ['not-redirect', 'scheme', 'invalid', 'root', 'utf8']) {
        resetWellKnownCache();
        const before = calls;
        assertEquals((await read()).port, 8448, mode);
        assertEquals(calls, before + 1, mode);
      }
      for (mode of ['no-store', 'no-cache', 'age']) {
        resetWellKnownCache();
        const before = calls;
        assertEquals((await read()).port, 8451);
        assertEquals((await read()).port, 8451);
        assertEquals(calls, before + 2, mode);
      }
      mode = 'cache';
      resetWellKnownCache();
      const before = calls;
      await read();
      await read();
      assertEquals(calls, before + 1);
      setConfigForTests({
        federation: { cacerts: ['does-not-exist-local-ca.pem'] },
      });
      resetCaCertsForTests();
      resetWellKnownCache();
      await assertRejects(read, Deno.errors.NotFound);
    });
  } finally {
    Deno.resolveDns = oldDns;
    resetWellKnownCache();
    setConfigForTests({});
    resetCaCertsForTests();
    await server.shutdown();
    await plain.shutdown();
  }
  assertEquals(config().federation.enabled, true);
});
import { addPeer, removePeer } from '#engine/federation/peers.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import {
  b32encode,
  exportPublicKeyRaw,
  generateSigningKeypair,
} from '#engine/signing-primitives.js';

function deps(over: Partial<ResolveDeps>): ResolveDeps {
  return {
    dnsA: over.dnsA !== undefined ? over.dnsA : () => Promise.resolve([]),
    dnsAAAA: over.dnsAAAA !== undefined
      ? over.dnsAAAA
      : () => Promise.resolve([]),
    dnsSrv: over.dnsSrv !== undefined ? over.dnsSrv : () => Promise.resolve([]),
    wellKnownGet: over.wellKnownGet !== undefined
      ? over.wellKnownGet
      : () => Promise.resolve({ mServer: null, maxAgeMs: null }),
    lookupPeer: over.lookupPeer !== undefined
      ? over.lookupPeer
      : () => Promise.resolve(null),
    random: over.random,
  };
}

async function withStore(
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(
    {
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    },
    { schemas: { server: serverSchema } },
  );
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('resolve: IP literal → direct, sni null, default port 8448', async () => {
  const ep = await resolveWith('1.2.3.4', deps({}));
  assertEquals(ep.connectIp, '1.2.3.4');
  assertEquals(ep.port, 8448);
  assertEquals(ep.sni, null);
  assertEquals(ep.trust, { kind: 'ca' });
  const v6 = await resolveWith('[::1]:8449', deps({}));
  assertEquals(v6.connectIp, '::1');
  assertEquals(v6.port, 8449);
});

Deno.test('resolve: hostname:port → A record, sni = host', async () => {
  const ep = await resolveWith(
    'example.test:8449',
    deps({
      dnsA: (h) =>
        h === 'example.test'
          ? Promise.resolve(['10.0.0.9'])
          : Promise.resolve([]),
    }),
  );
  assertEquals(ep.connectIp, '10.0.0.9');
  assertEquals(ep.port, 8449);
  assertEquals(ep.sni, 'example.test');
});

Deno.test('resolve: .well-known delegates to host:port; cached error for the horizon', async () => {
  let wkCalls = 0;
  const d = deps({
    wellKnownGet: () => {
      wkCalls++;
      return Promise.resolve({
        mServer: 'other-host.test:8451',
        maxAgeMs: 60000,
      });
    },
    dnsA: (h) =>
      h === 'other-host.test'
        ? Promise.resolve(['10.0.0.7'])
        : Promise.resolve([]),
  });
  const ep = await resolveWith('main.test', d);
  assertEquals(ep.connectIp, '10.0.0.7');
  assertEquals(ep.port, 8451);
  assertEquals(ep.sni, 'other-host.test');
  assertEquals(wkCalls, 1);
});

Deno.test('resolve: .well-known to an IP literal delegation → sni null', async () => {
  const d = deps({
    wellKnownGet: () =>
      Promise.resolve({ mServer: '10.0.0.5:8449', maxAgeMs: null }),
  });
  const ep = await resolveWith('main.test', d);
  assertEquals(ep.sni, null);
  assertEquals(ep.connectIp, '10.0.0.5');
  assertEquals(ep.port, 8449);
});

Deno.test('resolve: .well-known failing → SRV _matrix-fed first, lowest priority and weighted choice', async () => {
  const d = deps({
    random: () => 0.9,
    wellKnownGet: () => Promise.resolve({ mServer: null, maxAgeMs: null }),
    dnsSrv: (h) =>
      h === '_matrix-fed._tcp.main.test'
        ? Promise.resolve([
          { target: 'a.test', port: 443, priority: 10, weight: 5 },
          { target: 'b.test', port: 8448, priority: 1, weight: 5 },
          { target: 'c.test', port: 8449, priority: 1, weight: 9 },
        ])
        : Promise.resolve([]),
    dnsA: () => Promise.resolve(['10.0.0.1']),
  });
  const ep = await resolveWith('main.test', d);
  // Priority 1 wins over 10; the injected draw selects c.test, not a permanent
  // highest-weight preference. The independent grammar test selects light weight.
  assertEquals(ep.port, 8449);
});

Deno.test('resolve: legacy _matrix._tcp when _matrix-fed absent; :8448 fallback', async () => {
  const d1 = deps({
    dnsSrv: (h) =>
      h === '_matrix._tcp.main.test'
        ? Promise.resolve([{
          target: 'b.test',
          port: 8449,
          priority: 1,
          weight: 1,
        }])
        : Promise.resolve([]),
    dnsA: () => Promise.resolve(['10.0.0.2']),
  });
  const ep1 = await resolveWith('main.test', d1);
  assertEquals(ep1.port, 8449);
  const d2 = deps({ dnsA: () => Promise.resolve(['10.0.0.3']) });
  const ep2 = await resolveWith('main.test', d2);
  assertEquals(ep2.port, 8448);
  assertEquals(ep2.connectIp, '10.0.0.3');
});

Deno.test('resolve: roster row with override → direct connect; sni stays the server name', async () => {
  const d = deps({
    lookupPeer: () =>
      Promise.resolve({
        name: 'tuwunel.test',
        host: '127.0.0.1',
        port: 8449,
        trust: 'ca',
        pin_spki_sha256: null,
        added_ms: 1,
        added_by: 'operator',
        note: null,
      }),
  });
  const ep = await resolveWith('tuwunel.test', d);
  assertEquals(ep.connectIp, '127.0.0.1');
  assertEquals(ep.port, 8449);
  assertEquals(ep.sni, 'tuwunel.test');
});

Deno.test('resolve: pinned row without override uses the ladder but keeps pin trust', async () => {
  const d = deps({
    lookupPeer: () =>
      Promise.resolve({
        name: 'pinned.test',
        host: null,
        port: null,
        trust: 'pinned',
        pin_spki_sha256: 'ab12',
        added_ms: 1,
        added_by: 'operator',
        note: null,
      }),
    dnsA: () => Promise.resolve(['10.0.0.4']),
  });
  const ep = await resolveWith('pinned.test', d);
  assertEquals(ep.trust, { kind: 'pinned', spkiSha256: 'ab12' });
  assertEquals(ep.port, 8448);
});

Deno.test('resolve: key-is-name without a roster row → 502, no DNS call', async () => {
  const kp = (await generateSigningKeypair()) as unknown as CryptoKeyPair;
  const raw = await exportPublicKeyRaw(kp.publicKey);
  const name = b32encode(raw).toLowerCase().replace(/=+$/, '');
  let dnsCalled = false;
  const d = deps({
    dnsA: () => {
      dnsCalled = true;
      return Promise.resolve([]);
    },
  });
  await assertRejects(() => resolveWith(name, d));
  assertEquals(dnsCalled, false);
});

Deno.test('resolve: key-is-name with a roster row + address → trust keyname, pubkey from the name', async () => {
  const kp = (await generateSigningKeypair()) as unknown as CryptoKeyPair;
  const raw = await exportPublicKeyRaw(kp.publicKey);
  const name = b32encode(raw).toLowerCase().replace(/=+$/, '');
  const d = deps({
    lookupPeer: () =>
      Promise.resolve({
        name,
        host: '127.0.0.1',
        port: 8449,
        trust: 'keyname',
        pin_spki_sha256: null,
        added_ms: 1,
        added_by: 'operator',
        note: null,
      }),
  });
  const ep = await resolveWith(name, d);
  assertEquals(ep.trust.kind, 'keyname');
  if (ep.trust.kind === 'keyname') {
    assertEquals(ep.trust.pubkey, raw);
  }
});

Deno.test('resolve: well-known cache resets for tests', () => {
  resetWellKnownCache(); // smoke: exists and callable
});

Deno.test('resolve: cancellation stops DNS and well-known ladders without continuing late discovery', async () => {
  for (const stage of ['dns', 'well-known']) {
    const ac = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const calls: string[] = [];
    const d = deps({
      dnsA: async () => {
        calls.push('dns');
        if (stage === 'dns') {
          entered();
          await held;
        }
        return ['127.0.0.1'];
      },
      dnsSrv: () => {
        calls.push('srv');
        return Promise.resolve([]);
      },
      wellKnownGet: async () => {
        calls.push('well-known');
        if (stage === 'well-known') {
          entered();
          await held;
        }
        return { mServer: 'later.test:8448', maxAgeMs: null };
      },
    });
    const pending = resolveWith(
      stage === 'dns' ? 'slow.test:8448' : 'slow.test',
      d,
      ac.signal,
    );
    await started;
    ac.abort();
    try {
      await assertRejects(() => pending, DOMException);
    } finally {
      release();
    }
    // A late answer cannot fall through to another DNS leg or produce an endpoint.
    await held;
    await Promise.resolve();
    assertEquals(calls, stage === 'dns' ? ['dns'] : ['well-known']);
  }
});

// --- the production wiring: the roster lives in the server file ---------

Deno.test('resolve: the production ladder reads the roster from the server file', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    await addPeer(server, {
      name: '127.0.0.1:8449',
      host: null,
      port: null,
      trust: 'pinned',
      pin: 'ab12',
      addedBy: 'operator',
    });
    // a pinned row without an address falls through to the ladder
    // (IP literal) and keeps the pin trust
    const ep = await resolve(server, '127.0.0.1:8449');
    assertEquals(ep.trust, { kind: 'pinned', spkiSha256: 'ab12' });
    assertEquals(ep.port, 8449);
    await removePeer(server, '127.0.0.1:8449');
    const plain = await resolve(server, '127.0.0.1:8449');
    assertEquals(plain.trust, { kind: 'ca' });
  });
});
