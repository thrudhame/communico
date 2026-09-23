// tests/preview-dimensions.test.ts — PNG/GIF/JPEG header-only size. Pure.
import { assertEquals } from '@std/assert';
import { imageDimensions } from '#engine/preview/dimensions.ts';

Deno.test('PNG IHDR 279×129', () => {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b[16] = 0;
  b[17] = 0;
  b[18] = 0x01;
  b[19] = 0x17;
  b[20] = 0;
  b[21] = 0;
  b[22] = 0;
  b[23] = 0x81;
  assertEquals(imageDimensions(b), { width: 279, height: 129 });
});

Deno.test('GIF 279×129 LE', () => {
  const b = new Uint8Array([
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61,
    0x17,
    0x01,
    0x81,
    0x00,
  ]);
  assertEquals(imageDimensions(b), { width: 279, height: 129 });
});

Deno.test('JPEG SOF0 279×129', () => {
  const b = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    0x00,
    0x81,
    0x01,
    0x17,
    0x01,
  ]);
  assertEquals(imageDimensions(b), { width: 279, height: 129 });
});

Deno.test('unknown bytes omit dimensions', () => {
  assertEquals(imageDimensions(new Uint8Array([0, 1, 2, 3])), null);
});
