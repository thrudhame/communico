// tests/preview-cidr.test.ts — IPv4/IPv6 CIDR containment, including
// the shipped default blocklist. Pure.
import { assert, assertEquals } from '@std/assert';
import { cidrContains, parseCidr } from '#engine/preview/cidr.ts';

const DEFAULT = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '192.0.0.0/24',
  '169.254.0.0/16',
  '192.88.99.0/24',
  '198.18.0.0/15',
  '192.0.2.0/24',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '0.0.0.0/8',
  '::1/128',
  'fe80::/10',
  'fc00::/7',
  '2001:db8::/32',
  'ff00::/8',
  'fec0::/10',
  '::/128',
];

function inDefault(ip: string): boolean {
  for (const raw of DEFAULT) {
    const c = parseCidr(raw);
    if (c !== null && cidrContains(c, ip)) return true;
  }
  return false;
}

Deno.test('parseCidr rejects junk and oversize prefix', () => {
  assertEquals(parseCidr('not-a-cidr'), null);
  assertEquals(parseCidr('1.2.3.4'), null);
  assertEquals(parseCidr('1.2.3.4/33'), null);
  assertEquals(parseCidr('::1/129'), null);
  assertEquals(parseCidr('gggg::/128'), null);
});

Deno.test('v4 / v6 containment', () => {
  const c24 = parseCidr('192.168.1.0/24')!;
  assert(cidrContains(c24, '192.168.1.1'));
  assert(!cidrContains(c24, '192.168.2.1'));
  const c6 = parseCidr('2001:db8::/32')!;
  assert(cidrContains(c6, '2001:db8::1'));
  assert(!cidrContains(c6, '2001:db9::1'));
});

Deno.test('default blocklist covers loopback, RFC1918, link-local, docs', () => {
  assert(inDefault('127.0.0.1'));
  assert(inDefault('10.1.2.3'));
  assert(inDefault('172.16.0.1'));
  assert(inDefault('192.168.0.1'));
  assert(inDefault('169.254.1.1'));
  assert(inDefault('192.0.2.1'));
  assert(inDefault('0.0.0.1'));
  assert(inDefault('::1'));
  assert(inDefault('fe80::1'));
  assert(inDefault('fc00::1'));
  assert(inDefault('2001:db8::1'));
  assert(!inDefault('8.8.8.8'));
  assert(!inDefault('1.1.1.1'));
  assert(!inDefault('2001:4860:4860::8888'));
});
