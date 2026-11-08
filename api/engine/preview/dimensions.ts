// api/engine/preview/dimensions.ts — header-only image size. PNG IHDR
// at bytes 16–24, GIF at 6–10 LE, JPEG walks SOF0/SOF2. Anything else:
// omit width/height.

export type Dimensions = { width: number; height: number };

function u16be(b: Uint8Array, i: number): number {
  return (b[i] << 8) | b[i + 1];
}

function u16le(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8);
}

function u32be(b: Uint8Array, i: number): number {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

function png(b: Uint8Array): Dimensions | null {
  if (b.length < 24) return null;
  if (
    b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47 ||
    b[4] !== 0x0d || b[5] !== 0x0a || b[6] !== 0x1a || b[7] !== 0x0a
  ) {
    return null;
  }
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

function gif(b: Uint8Array): Dimensions | null {
  if (b.length < 10) return null;
  const sig = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5]);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

function jpeg(b: Uint8Array): Dimensions | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    while (i < b.length && b[i] === 0xff) i++;
    if (i >= b.length) return null;
    const marker = b[i];
    i++;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (i + 1 >= b.length) return null;
    const seglen = u16be(b, i);
    if (seglen < 2) return null;
    if (marker === 0xc0 || marker === 0xc2) {
      if (i + 6 >= b.length) return null;
      const height = u16be(b, i + 3);
      const width = u16be(b, i + 5);
      if (width === 0 || height === 0) return null;
      return { width, height };
    }
    i += seglen;
  }
  return null;
}

export function imageDimensions(bytes: Uint8Array): Dimensions | null {
  const p = png(bytes);
  if (p !== null) return p;
  const g = gif(bytes);
  if (g !== null) return g;
  return jpeg(bytes);
}
