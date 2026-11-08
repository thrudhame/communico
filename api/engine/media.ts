// doltgres media behavior: tenant metadata and bytes under [media] root.
import { theApp } from '#engine/app.ts';
import { config, serverName } from '#engine/config.ts';
import { getMedia } from '#engine/tenant/media.ts';
import { MatrixError } from '#engine/matrix-error.ts';

export function mediaRoot(): string {
  return config().media.root;
}
export function mediaMaxBytes(): number {
  return config().media.maxbytes;
}
export function newMediaId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(
    /=+$/,
    '',
  );
}

// Validate both components before touching metadata or the filesystem.
const MXC_COMPONENT = /^[A-Za-z0-9_-]+$/;
export function assertLocalMxc(mxcServerName: string, mediaId: string): void {
  if (
    !MXC_COMPONENT.test(mxcServerName) || !MXC_COMPONENT.test(mediaId) ||
    mxcServerName !== serverName()
  ) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'Unknown media');
  }
}

export const INLINE_CONTENT_TYPES: readonly string[] = [
  'text/css',
  'text/plain',
  'text/csv',
  'application/json',
  'application/ld+json',
  'image/jpeg',
  'image/gif',
  'image/png',
  'image/apng',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'audio/mp4',
  'audio/webm',
  'audio/aac',
  'audio/mpeg',
  'audio/ogg',
  'audio/wave',
  'audio/wav',
  'audio/x-wav',
  'audio/x-pn-wav',
  'audio/flac',
  'audio/x-flac',
];

function filenameParameter(name: string): string {
  if (/^[\x20-\x7e]+$/.test(name)) {
    return `filename="${name.replace(/(["\\])/g, '\\$1')}"`;
  }
  const encoded = encodeURIComponent(name).replace(
    /[*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `filename*=UTF-8''${encoded}`;
}

export function contentDisposition(
  contentType: string,
  filename: string | null,
): string {
  const mediaType = (contentType.split(';')[0] ?? contentType).trim()
    .toLowerCase();
  const disposition = INLINE_CONTENT_TYPES.includes(mediaType)
    ? 'inline'
    : 'attachment';
  return filename === null
    ? disposition
    : `${disposition}; ${filenameParameter(filename)}`;
}

// The direct POST and reserved-id PUT share the old streamed size cap and
// .part cleanup. Only a completed stream is renamed to the final byte path.
export async function storeUploadBody(
  stream: ReadableStream<Uint8Array> | null,
  mediaId: string,
): Promise<number> {
  const partPath = `${mediaRoot()}/${mediaId}.part`;
  const finalPath = `${mediaRoot()}/${mediaId}`;
  const limit = mediaMaxBytes();
  const file = await Deno.create(partPath);
  const writer = file.writable.getWriter();
  let size = 0;
  try {
    if (stream !== null) {
      for await (const chunk of stream) {
        size += chunk.byteLength;
        if (size > limit) {
          throw new MatrixError(
            413,
            'M_TOO_LARGE',
            'Upload exceeds the server limit',
          );
        }
        await writer.write(chunk);
      }
    }
    await writer.close();
    await Deno.rename(partPath, finalPath);
  } catch (error) {
    await writer.abort().catch(() => {});
    await Deno.remove(partPath).catch(() => {});
    throw error;
  }
  return size;
}

export async function serveMedia(
  mxcServerName: string,
  mediaId: string,
): Promise<Response> {
  assertLocalMxc(mxcServerName, mediaId);
  const row = await getMedia(theApp().tenant, mediaId);
  if (row === null) throw new MatrixError(404, 'M_NOT_FOUND', 'Unknown media');
  if (row.state !== 'uploaded') {
    throw new MatrixError(
      504,
      'M_NOT_YET_UPLOADED',
      'Content is not yet available',
    );
  }
  const file = await Deno.open(`${mediaRoot()}/${mediaId}`, { read: true });
  const contentType = row.content_type ?? 'application/octet-stream';
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Disposition': contentDisposition(contentType, row.filename),
    'Content-Security-Policy':
      "sandbox; default-src 'none'; script-src 'none'; plugin-types application/pdf; style-src 'unsafe-inline'; object-src 'self';",
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  if (row.size_bytes !== null) {
    headers.set('Content-Length', String(row.size_bytes));
  }
  return new Response(file.readable, { headers });
}
