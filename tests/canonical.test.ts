import { assertEquals } from '@std/assert';
import { canonicalJson } from '../api/engine/canonical.ts';

Deno.test('canonicalJson: sorted keys at every level, no whitespace', () => {
  assertEquals(
    canonicalJson({ b: 2, a: { d: [4, { z: 1, y: 2 }], c: 3 } }),
    '{"a":{"c":3,"d":[4,{"y":2,"z":1}]},"b":2}',
  );
});
