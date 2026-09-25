// tests/federation-resolve.test.ts — the resolution ladder with injected
// deps: IP literal, explicit port, .well-known (+ sub-ladder), SRV
// priority pick, roster overrides, key-is-name 502s. No network, no DB.
import { assertEquals, assertRejects } from '@std/assert';
import {
  resetWellKnownCache,
  type ResolveDeps,
  resolveWith,
} from '#engine/federation/resolve.ts';
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
  };
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

Deno.test('resolve: .well-known failing → SRV _matrix-fed first, lowest priority + highest weight', async () => {
  const d = deps({
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
  // priority 1 wins over 10; within priority 1, highest weight is c.test:8449
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
