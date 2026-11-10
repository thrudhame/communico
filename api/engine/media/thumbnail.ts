import { MatrixError } from '#engine/matrix-error.ts';

export type Thumbnail = {
  width: number;
  height: number;
  method: 'scale' | 'crop';
  animated: boolean;
};
export function thumbnailQuery(
  query: URLSearchParams,
  maxDimension: number,
): Thumbnail {
  const dimension = (key: string) => {
    const raw = query.get(key);
    const n = raw === null || !/^\d+$/.test(raw) ? NaN : Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0 || n > maxDimension) {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        'Invalid thumbnail dimensions',
      );
    }
    return n;
  };
  const method = query.get('method') ?? 'scale';
  const animated = query.get('animated') ?? 'false';
  if (
    (method !== 'scale' && method !== 'crop') ||
    (animated !== 'true' && animated !== 'false')
  ) throw new MatrixError(400, 'M_INVALID_PARAM', 'Invalid thumbnail options');
  return {
    width: dimension('width'),
    height: dimension('height'),
    method,
    animated: animated === 'true',
  };
}
export type ThumbnailLimits = {
  maxbytes: number;
  maxpixels: number;
  maxdimension: number;
  thumbnailms: number;
  thumbnailworkers: number;
};

// Reject dimensions before handing compressed bytes to a decoder. Only PNG/JPEG
// are supported: ciphertext, SVG/HTML and other codecs never reach Image.decode.
export function imageGeometry(
  bytes: Uint8Array,
  limits: ThumbnailLimits,
): { width: number; height: number } {
  let width = 0, height = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > limits.maxbytes) {
    throw new MatrixError(413, 'M_TOO_LARGE', 'Image exceeds byte limit');
  }
  if (
    bytes.length >= 33 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b) &&
    view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at++] !== 255) break;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (at + 2 > bytes.length) break;
      const length = view.getUint16(at);
      if (length < 2 || at + length > bytes.length) break;
      if (
        [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]
          .includes(marker)
      ) {
        if (length < 8) break;
        height = view.getUint16(at + 3);
        width = view.getUint16(at + 5);
        break;
      }
      at += length;
    }
  }
  if (!width || !height) {
    throw new MatrixError(
      400,
      'M_UNKNOWN',
      'Only valid PNG/JPEG images can be thumbnailed',
    );
  }
  if (
    width > limits.maxdimension || height > limits.maxdimension ||
    width * height > limits.maxpixels
  ) {
    throw new MatrixError(
      413,
      'M_TOO_LARGE',
      'Image exceeds decoded geometry limit',
    );
  }
  return { width, height };
}
export class ThumbnailWorkers {
  private active = 0;
  private waiters: (() => void)[] = [];
  private controller = new AbortController();
  private workers = new Set<Worker>();
  constructor(
    private createWorker = () =>
      new Worker(new URL('./thumbnail-worker.ts', import.meta.url).href, {
        type: 'module',
      }),
  ) {}
  close() {
    this.controller.abort();
    for (const worker of this.workers) worker.terminate();
    for (const wake of this.waiters.splice(0)) wake();
  }
  async render(
    source: () => Promise<Uint8Array>,
    options: Thumbnail,
    limits: ThumbnailLimits,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (this.waiters.length >= limits.thumbnailworkers * 16) {
      throw new MatrixError(429, 'M_LIMIT_EXCEEDED', 'Thumbnail workers busy');
    }
    const bounded = AbortSignal.any([signal, this.controller.signal]);
    while (this.active >= limits.thumbnailworkers) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          bounded.removeEventListener('abort', cancel);
          resolve();
        };
        const cancel = () => {
          const at = this.waiters.indexOf(wake);
          if (at >= 0) this.waiters.splice(at, 1);
          reject(bounded.reason);
        };
        bounded.throwIfAborted();
        this.waiters.push(wake);
        bounded.addEventListener('abort', cancel, { once: true });
      });
    }
    bounded.throwIfAborted();
    this.active++;
    try {
      const bytes = await source();
      bounded.throwIfAborted();
      imageGeometry(bytes, limits);
      return await new Promise<Uint8Array>((resolve, reject) => {
        const worker = this.createWorker();
        this.workers.add(worker);
        const finish = (result: Uint8Array | null, error?: unknown) => {
          clearTimeout(timer);
          bounded.removeEventListener('abort', abort);
          this.workers.delete(worker);
          worker.terminate();
          if (result) resolve(result);
          else reject(error);
        };
        const abort = () => finish(null, bounded.reason);
        const timer = setTimeout(
          () =>
            finish(
              null,
              new MatrixError(504, 'M_UNKNOWN', 'Thumbnail decode timed out'),
            ),
          limits.thumbnailms,
        );
        bounded.addEventListener('abort', abort, { once: true });
        worker.onerror = (event) => {
          event.preventDefault();
          finish(
            null,
            new MatrixError(400, 'M_UNKNOWN', 'Image decode failed'),
          );
        };
        worker.onmessage = (event) => {
          if (!(event.data instanceof Uint8Array)) {
            finish(
              null,
              new MatrixError(400, 'M_UNKNOWN', 'Image decode failed'),
            );
            return;
          }
          try {
            imageGeometry(event.data, limits);
            if (event.data.length > limits.maxbytes) {
              throw new Error('thumbnail too large');
            }
            finish(event.data);
          } catch (error) {
            finish(null, error);
          }
        };
        worker.postMessage({ bytes, options, maxPixels: limits.maxpixels }, [
          bytes.buffer as ArrayBuffer,
        ]);
      });
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}
