import { assert, assertEquals } from '@std/assert';
import { newMediaId } from '#engine/media.ts';
import { b64encode, b64encodeStd } from '#engine/signing-primitives.js';

Deno.test('generated identifiers: shared byte encoder uses unpadded base64url', () => {
  for (
    const [bytes, expected] of [
      [new Uint8Array([0xfb]), '-w'],
      [new Uint8Array([0xff, 0xff]), '__8'],
      [new Uint8Array([0xfb, 0xff, 0xff]), '-___'],
    ] as const
  ) {
    assertEquals(b64encode(bytes), expected);
    const query = new URLSearchParams({ id: expected });
    assertEquals(query.toString(), `id=${expected}`);
  }
  const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  const standard = b64encodeStd(allBytes);
  assert(standard.includes('+') && standard.includes('/'));
  assert(/^[A-Za-z0-9_-]+$/.test(b64encode(allBytes)));
  assertEquals(
    b64encode(allBytes),
    standard.replaceAll('+', '-').replaceAll('/', '_'),
  );
});

Deno.test('generated identifiers: media and reserved uploads share the URL-safe encoder', () => {
  const original = crypto.getRandomValues;
  // Exercise both unsafe standard characters on every run, without chance.
  crypto.getRandomValues = ((bytes: Uint8Array) => {
    assertEquals(bytes.length, 18);
    bytes.fill(0xff);
    bytes[0] = 0xfb;
    return bytes;
  }) as typeof crypto.getRandomValues;
  try {
    const id = newMediaId();
    assertEquals(id, '-' + '_'.repeat(23));
    assert(/^[A-Za-z0-9_-]+$/.test(id));
    assertEquals(
      new URL(`https://example.test/upload/${id}`).pathname.split('/'),
      [
        '',
        'upload',
        id,
      ],
    );
  } finally {
    crypto.getRandomValues = original;
  }
});
