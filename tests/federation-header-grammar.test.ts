import { assertEquals } from '@std/assert';
import { parseXMatrixHeaders } from '#engine/federation/xmatrix.ts';

const base = 'origin="remote.test",key="ed25519:1",sig="abc"';
Deno.test('X-Matrix grammar: quoted scheme-like data is not a second authorization', () => {
  assertEquals(
    parseXMatrixHeaders([
      'X-Matrix ' +
      base.replace(',key=', ',extension="a, X-Matrix value",key='),
    ]),
    [{
      origin: 'remote.test',
      key: 'ed25519:1',
      signature: 'abc',
      destination: null,
    }],
  );
  assertEquals(
    parseXMatrixHeaders([
      'Basic ignored, x-matrix ' + base + ', X-Matrix ' +
      base.replace('remote.test', 'second.test'),
    ]).map((p) => p.origin),
    ['remote.test', 'second.test'],
  );
  assertEquals(
    parseXMatrixHeaders([
      'X-Matrix origin=remote.test, key="ed25519:1", signature=abc, extra="quoted\\"pair"',
    ]).length,
    1,
  );
});
Deno.test('X-Matrix grammar: duplicate, unterminated, non-token and trailing garbage candidates are refused', () => {
  for (
    const block of [
      base + ',origin="other.test"',
      base + ',ORIGIN="other.test"',
      base + ',extension="unterminated',
      base + ',bad:name=value',
      base + ',extension=unquoted:value',
      base + ',extension="ok"garbage',
      base + ',extension="bad\rvalue"',
      base + ',extension="dangling\\',
      base + ',signature="different"',
      base.replace('key="ed25519:1"', 'key=ed25519:1'),
    ]
  ) assertEquals(parseXMatrixHeaders(['X-Matrix ' + block]), [], block);
});
