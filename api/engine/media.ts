// doltgres media behavior: tenant metadata and bytes under [media] root.
import { theApp } from '#engine/app.ts';
import { config, serverName } from '#engine/config.ts';
import {
  createMedia,
  getMedia,
  markUploaded,
  type MediaMeta,
} from '#engine/tenant/media.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { b64encode } from '#engine/signing-primitives.js';

export function mediaRoot(): string {
  return config().media.root;
}
export function mediaMaxBytes(): number {
  return config().media.maxbytes;
}
export function newMediaId(): string {
  return b64encode(crypto.getRandomValues(new Uint8Array(18)));
}

// Only the media id becomes a filesystem component. The server name must
// match configuration exactly, including any dots, port or IPv6 literal.
const MXC_MEDIA_ID = /^[A-Za-z0-9_-]+$/;
export function assertLocalMxc(mxcServerName: string, mediaId: string): void {
  if (
    !MXC_MEDIA_ID.test(mediaId) ||
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

// Admission, bytes and metadata have one owner across direct/reserved uploads
// and preview images. In particular, no adapter may check pending and then
// overwrite bytes after a competing upload has published its metadata.
const uploads = new Map<string, Promise<void>>();
export async function uploadMedia(
  tenant: Tenant,
  localpart: string,
  stream: ReadableStream<Uint8Array> | null,
  meta: Omit<MediaMeta, 'size_bytes'>,
  reservation?: string,
): Promise<{ mediaId: string; sizeBytes: number }> {
  const mediaId = reservation ?? newMediaId();
  if (!MXC_MEDIA_ID.test(mediaId)) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'Unknown media ID');
  }
  const root = mediaRoot();
  const key = root + '/' + mediaId;
  const previous = uploads.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => release = resolve);
  const tail = previous.then(() => mine);
  uploads.set(key, tail);
  await previous;
  try {
    const row = await getMedia(tenant, mediaId);
    if (reservation !== undefined && row === null) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'Unknown media ID');
    }
    if (row !== null && row.localpart !== localpart) {
      throw new MatrixError(
        403,
        'M_FORBIDDEN',
        'Media belongs to a different user',
      );
    }
    if (
      row?.state === 'uploaded' || (reservation === undefined && row !== null)
    ) {
      throw new MatrixError(
        409,
        'M_CANNOT_OVERWRITE_MEDIA',
        'Media already uploaded',
      );
    }
    const sizeBytes = await storeUploadBody(stream, root, mediaId);
    const uploaded = { ...meta, size_bytes: sizeBytes };
    if (reservation === undefined) {
      await createMedia(tenant, localpart, mediaId, 'uploaded', uploaded);
    } else {
      await markUploaded(tenant, mediaId, uploaded);
    }
    return { mediaId, sizeBytes };
  } finally {
    release();
    if (uploads.get(key) === tail) uploads.delete(key);
  }
}

// The handle stays open until fsync, unlike FsFile.writable.close(). A unique
// private part also keeps a crash leftover from blocking a pending-id retry.
async function storeUploadBody(
  stream: ReadableStream<Uint8Array> | null,
  root: string,
  mediaId: string,
): Promise<number> {
  const partPath = `${root}/${mediaId}.${crypto.randomUUID()}.part`;
  const finalPath = `${root}/${mediaId}`;
  const limit = mediaMaxBytes();
  let file: Deno.FsFile | null = await Deno.open(partPath, {
    createNew: true,
    write: true,
    mode: 0o600,
  });
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
        let offset = 0;
        while (offset < chunk.length) {
          const written = await file.write(chunk.subarray(offset));
          if (written <= 0) throw new Error('short media upload write');
          offset += written;
        }
      }
    }
    await file.sync();
    file.close();
    file = null;
    await Deno.rename(partPath, finalPath);
    const directory = await Deno.open(root, { read: true });
    try {
      await directory.sync();
    } finally {
      directory.close();
    }
  } catch (error) {
    file?.close();
    await Deno.remove(partPath).catch((cleanup) => {
      if (!(cleanup instanceof Deno.errors.NotFound)) throw cleanup;
    });
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
    'X-Content-Type-Options': 'nosniff',
  });
  if (row.size_bytes !== null) {
    headers.set('Content-Length', String(row.size_bytes));
  }
  return new Response(file.readable, { headers });
}
