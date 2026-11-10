import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { Animation, Frame, Image } from 'imagescript';
import {
  imageGeometry,
  type ThumbnailLimits,
  thumbnailQuery,
  ThumbnailWorkers,
} from '#engine/media/thumbnail.ts';

const limits: ThumbnailLimits = {
  maxbytes: 100000,
  maxpixels: 10000,
  maxdimension: 1000,
  thumbnailms: 5000,
  thumbnailworkers: 1,
};
const options = {
  width: 8,
  height: 8,
  method: 'scale' as const,
  animated: false,
};
const signal = () => new AbortController().signal;
Deno.test('thumbnail worker: PNG/JPEG scale/crop are real, no upscale, output is static PNG', async () => {
  const workers = new ThumbnailWorkers();
  try {
    const image = new Image(16, 12);
    image.bitmap.fill(255);
    for (const format of ['PNG', 'JPEG'] as const) {
      for (const method of ['scale', 'crop'] as const) {
        const source = await image
          [format === 'PNG' ? 'encodePNG' : 'encodeJPEG']();
        const output = await workers.render(
          () => Promise.resolve(source),
          { ...options, method },
          limits,
          signal(),
        );
        assertEquals([...output.subarray(0, 8)], [
          137,
          80,
          78,
          71,
          13,
          10,
          26,
          10,
        ]);
        const decoded = await Image.decode(output);
        assertEquals(
          [decoded.width, decoded.height],
          method === 'scale' ? [8, 6] : [8, 8],
        );
        assertEquals(new TextDecoder().decode(output).includes('acTL'), false);
      }
    }
    const small = await image.encodePNG();
    const output = await workers.render(
      () => Promise.resolve(small),
      { ...options, width: 100, height: 100, method: 'crop' },
      limits,
      signal(),
    );
    const decoded = await Image.decode(output);
    assertEquals([decoded.width, decoded.height], [12, 12]);
  } finally {
    workers.close();
  }
});
Deno.test('thumbnail preflight: ciphertext/HTML, dimensions, pixel/byte bombs and malformed PNG/JPEG refused', async () => {
  const workers = new ThumbnailWorkers();
  try {
    for (
      const bytes of [
        new Uint8Array([1, 2, 3]),
        new TextEncoder().encode('<svg></svg>'),
        new Uint8Array([255, 216, 255, 192, 255, 255]),
      ]
    ) {
      await assertRejects(() =>
        workers.render(() => Promise.resolve(bytes), options, limits, signal())
      );
    }
    const image = new Image(16, 12);
    const source = await image.encodePNG();
    await assertRejects(() =>
      workers.render(() => Promise.resolve(source.slice()), options, {
        ...limits,
        maxpixels: 4,
      }, signal())
    );
    await assertRejects(() =>
      workers.render(() => Promise.resolve(source.slice()), options, {
        ...limits,
        maxbytes: 4,
      }, signal())
    );
    const bomb = source.slice();
    new DataView(bomb.buffer).setUint32(16, 0x7fffffff);
    await assertRejects(() =>
      workers.render(() => Promise.resolve(bomb), options, limits, signal())
    );
    assertEquals(imageGeometry(source, limits), { width: 16, height: 12 });
  } finally {
    workers.close();
  }
});
Deno.test('thumbnail worker: CPU-bound decoder is terminated by deadline, slot released for the next image', async () => {
  let calls = 0;
  const workers = new ThumbnailWorkers(() =>
    ++calls === 1
      ? new Worker(
        'data:application/javascript,onmessage%3D()%3D%3E%7Bwhile(true)%7B%7D%7D',
        { type: 'module' },
      )
      : new Worker(
        new URL('../api/engine/media/thumbnail-worker.ts', import.meta.url)
          .href,
        { type: 'module' },
      )
  );
  try {
    const image = new Image(2, 2);
    await assertRejects(() =>
      workers.render(() => image.encodePNG(), options, {
        ...limits,
        thumbnailms: 30,
      }, signal())
    );
    const result = await workers.render(
      () => image.encodePNG(),
      options,
      limits,
      signal(),
    );
    assertEquals(imageGeometry(result, limits), { width: 2, height: 2 });
  } finally {
    workers.close();
  }
});

Deno.test('thumbnail worker: real two-frame APNG becomes one static default image when animated=false', async () => {
  const a = new Frame(4, 4);
  a.bitmap.fill(255);
  const b = new Frame(4, 4);
  b.bitmap.fill(31);
  const source = await new Animation([a, b]).encodeAPNG({ optimize: false });
  assertEquals((await Animation.decode(source)).frames.length, 2);
  const workers = new ThumbnailWorkers();
  try {
    const output = await workers.render(
      () => Promise.resolve(source),
      { ...options, width: 2, height: 2, animated: false },
      limits,
      signal(),
    );
    assertEquals(new TextDecoder().decode(output).includes('acTL'), false);
    assertEquals((await Animation.decode(output)).frames.length, 1);
    assertEquals([...(await Image.decode(output)).bitmap.subarray(0, 4)], [
      255,
      255,
      255,
      255,
    ]);
  } finally {
    workers.close();
  }
});
Deno.test('thumbnail query: required bounded dimensions, explicit methods and static flag', () => {
  assertEquals(thumbnailQuery(new URLSearchParams('width=8&height=6'), 100), {
    width: 8,
    height: 6,
    method: 'scale',
    animated: false,
  });
  for (
    const query of [
      '',
      'width=0&height=1',
      'width=1&height=1001',
      'width=1.5&height=2',
      'width=1&height=2&method=bogus',
      'width=1&height=2&animated=oops',
    ]
  ) {
    assertThrows(() => thumbnailQuery(new URLSearchParams(query), 100));
  }
});
