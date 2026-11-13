import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { config } from '#engine/config.ts';
import { claimedKey } from '#engine/e2ee-wire.ts';
import { keyDocument } from '#engine/federation/key-document.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { cidrContains, parseCidr } from '#engine/preview/cidr.ts';
import { guardedGet } from '#engine/preview/guard.ts';

Deno.test('review boundary: known unsigned claim algorithms require string material', () => {
  const key = 'A'.repeat(43);
  for (const algorithm of ['curve25519', 'ed25519']) {
    claimedKey(key, algorithm, config().e2ee);
    for (const material of [key, '!']) {
      assertEquals(
        assertThrows(() =>
          claimedKey(
            { key: material, signatures: {} },
            algorithm,
            config().e2ee,
          ), UpstreamError).category,
        'protocol',
      );
    }
  }
  claimedKey({ key, signatures: {} }, 'signed_curve25519', config().e2ee);
  claimedKey(
    { key: 'extension', signatures: {} },
    'future_algorithm',
    config().e2ee,
  );
});

Deno.test('review boundary: a key identifier has one current or retired owner', () => {
  const entry = { key: 'A'.repeat(43) };
  const doc = {
    server_name: 'peer.test',
    valid_until_ts: 1,
    verify_keys: { 'ed25519:one': entry },
    old_verify_keys: { 'ed25519:one': { ...entry, expired_ts: 0 } },
    signatures: {},
  };
  assertEquals(
    assertThrows(() => keyDocument(doc), UpstreamError).category,
    'protocol',
  );
  keyDocument({
    ...doc,
    old_verify_keys: { 'ed25519:other': { ...entry, expired_ts: 0 } },
  });
});

Deno.test('review boundary: IPv4 preview policy covers mapped IPv6 identities', async () => {
  const loopback = parseCidr('127.0.0.0/8')!;
  for (const ip of ['127.0.0.1', '::ffff:7f00:1', '::ffff:127.0.0.1']) {
    assertEquals(cidrContains(loopback, ip), true, ip);
  }
  assertEquals(cidrContains(loopback, '::ffff:c000:201'), false);
  assertEquals(
    cidrContains(parseCidr('::ffff:0:0/96')!, '::ffff:7f00:1'),
    true,
  );
  assertEquals(cidrContains(parseCidr('::1/128')!, '::ffff:7f00:1'), false);
  const error = await assertRejects(
    () =>
      guardedGet('http://[::ffff:7f00:1]:1/', {
        maxBytes: 1024,
        blocklist: ['127.0.0.0/8'],
        allowlist: [],
        acceptLanguage: null,
      }),
    UpstreamError,
  );
  assertEquals(error.category, 'validation');
  assertEquals(error.context.phase, 'preview-policy');
});
