/// <reference lib="deno.worker" />
// ImageScript 3.20.2, pure TypeScript, (MIT OR AGPL-3.0-or-later).
// The parent preflights PNG/JPEG geometry, owns concurrency and terminates this
// worker at its deadline. No untrusted executable code or external URLs enter.
import { Image } from 'imagescript';
import type { Thumbnail } from './thumbnail.ts';

self.onmessage = async (
  event: MessageEvent<
    { bytes: Uint8Array; options: Thumbnail; maxPixels: number }
  >,
) => {
  try {
    const { bytes, options, maxPixels } = event.data;
    const image = await Image.decode(bytes, { maxPixels });
    if (options.method === 'crop') {
      const width = Math.max(
        1,
        Math.min(
          image.width,
          Math.floor(image.height * options.width / options.height),
        ),
      );
      const height = Math.max(
        1,
        Math.min(
          image.height,
          Math.floor(image.width * options.height / options.width),
        ),
      );
      image.crop(
        Math.floor((image.width - width) / 2),
        Math.floor((image.height - height) / 2),
        width,
        height,
      );
    }
    const factor = Math.min(
      1,
      options.width / image.width,
      options.height / image.height,
    );
    const width = Math.max(1, Math.floor(image.width * factor)),
      height = Math.max(1, Math.floor(image.height * factor));
    if (width !== image.width || height !== image.height) {
      image.resize({ width, height });
    }
    // A fresh bitmap strips EXIF/ICC and all animation metadata. PNG/APNG input
    // uses its default image; output is always one static PNG, also for animated=true.
    const flat = new Image(image.width, image.height);
    flat.bitmap.set(image.bitmap);
    const result = new Uint8Array(await flat.encodePNG());
    self.postMessage(result, [result.buffer]);
  } catch {
    self.postMessage({ error: 'unsupported or malformed image' });
  }
};
