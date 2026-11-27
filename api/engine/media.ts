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
import type { Capacity } from '#engine/store/capacity.ts';
import { isStoragePressure, storageFailure } from '#engine/store/pressure.ts';
import { withStorageHold } from '#engine/store/holds.ts';
import { b64encode } from '#engine/signing-primitives.js';
import { createHash } from 'node:crypto';

export function mediaRoot(): string {
  return config().media.root;
}
export function mediaMaxBytes(): number {
  return config().media.maxbytes;
}
export function declaredUploadBytes(headers: Headers): number | undefined {
  const length = headers.get('content-length');
  if (length === null || !/^\d+$/.test(length)) return;
  const bytes = Number(length);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}
export function newMediaId(): string {
  const random = b64encode(crypto.getRandomValues(new Uint8Array(18)));
  const issuer = localIssuer();
  return issuer === null ? random : issuerPrefix(issuer) + random;
}

function localIssuer(): string | null {
  return config().server.role === 'facade' ? config().facade.nodeid : null;
}

// Existing IDs are exactly 24 base64url characters. The node tag is fixed
// width even for long configured node IDs, keeping the full ID MXC-safe.
function issuerPrefix(node: string): string {
  return 'n1_' + createHash('sha256').update(node).digest('hex') + '_';
}

export function mediaIssuedBy(mediaId: string, node: string): boolean {
  const prefix = issuerPrefix(node);
  return mediaId.startsWith(prefix) &&
    /^[A-Za-z0-9_-]{24}$/.test(mediaId.slice(prefix.length));
}

const RESERVATION_MS = 86_400_000;
export async function reserveMedia(tenant: Tenant, localpart: string) {
  const mediaId = newMediaId();
  const row = await tenant.tx(async (tx) => {
    await tx.media.insert(localpart, mediaId, 'pending', {});
    return await tx.media.byId(mediaId);
  });
  if (row === null) {
    throw new Error('Media reservation vanished in its creating transaction');
  }
  return { mediaId, expires: row.created_ms + RESERVATION_MS };
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
  options: { reservation?: string; capacity?: Capacity; maxBytes?: number } =
    {},
): Promise<{ mediaId: string; sizeBytes: number }> {
  const { reservation } = options;
  const mediaId = reservation ?? newMediaId();
  const issuer = localIssuer();
  if (
    !MXC_MEDIA_ID.test(mediaId) ||
    (issuer !== null && !mediaIssuedBy(mediaId, issuer))
  ) {
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
    if (
      reservation !== undefined &&
      (row === null ||
        (row.state === 'pending' &&
          Date.now() >= row.created_ms + RESERVATION_MS))
    ) {
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
    const limit = Math.min(mediaMaxBytes(), options.maxBytes ?? Infinity);
    const { sizeBytes, digest } = await storeUploadBody(
      stream,
      root,
      mediaId,
      stream === null ? 0 : limit,
      options.capacity,
      issuer !== null,
    );
    const uploaded = { ...meta, size_bytes: sizeBytes };
    try {
      if (issuer !== null) {
        await tenant.tx(async (tx) => {
          if (reservation === undefined) {
            await tx.media.insert(localpart, mediaId, 'uploaded', uploaded);
          } else {
            await tx.media.markUploaded(mediaId, uploaded);
          }
          await tx.media.recordExport(mediaId, issuer, digest);
        });
      } else if (reservation === undefined) {
        await createMedia(tenant, localpart, mediaId, 'uploaded', uploaded);
      } else {
        await markUploaded(tenant, mediaId, uploaded);
      }
    } catch (error) {
      // A refused metadata write keeps the old pending row (if any). Remove
      // this attempt's unpublished bytes before unlocking that upload ID.
      if (issuer === null && isStoragePressure(error)) {
        if (options.capacity) await options.capacity.remove(key);
        else await Deno.remove(key);
      } else if (
        issuer !== null &&
        (await getMedia(tenant, mediaId))?.state !== 'uploaded'
      ) {
        // An unknown transaction outcome must never erase a committed file.
        await removeUploadFile(key, options.capacity);
      }
      throw error;
    }
    return { mediaId, sizeBytes };
  } catch (error) {
    throw storageFailure(error);
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
  limit: number,
  capacity: Capacity | undefined,
  strict: boolean,
): Promise<{ sizeBytes: number; digest: string }> {
  await capacity?.ensureDirectory(root, 0o700);
  const partPath = `${root}/${mediaId}.${crypto.randomUUID()}.part`;
  const lease = await capacity?.reserveStaging(partPath, limit);
  lease?.track(`${root}/${mediaId}`);
  try {
    const write = () =>
      writeUploadBody(stream, root, mediaId, limit, partPath, strict);
    return await (lease ? withStorageHold(write) : write());
  } finally {
    // On successful publication inventory accounts for the final file. Release
    // before the metadata transaction so it can independently claim its WAL.
    lease?.release();
  }
}

async function writeUploadBody(
  stream: ReadableStream<Uint8Array> | null,
  root: string,
  mediaId: string,
  limit: number,
  partPath: string,
  strict: boolean,
): Promise<{ sizeBytes: number; digest: string }> {
  const finalPath = `${root}/${mediaId}`;
  // The media root belongs to this facade; a store lock is not a lock on a
  // separately configured media root. Install without replacement even if an
  // earlier ambiguous attempt or another writer left a final at this path.
  let file: Deno.FsFile | null = await Deno.open(partPath, {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  let size = 0;
  const hash = createHash('sha256');
  let installed = false;
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
        hash.update(chunk);
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
    if (strict) {
      try {
        await Deno.link(partPath, finalPath);
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
        throw new MatrixError(
          503,
          'M_UNAVAILABLE',
          'Media publication unavailable',
        );
      }
      installed = true;
      await Deno.remove(partPath);
    } else {
      await Deno.rename(partPath, finalPath);
      installed = true;
    }
    const directory = await Deno.open(root, { read: true });
    try {
      await directory.sync();
    } finally {
      directory.close();
    }
  } catch (error) {
    file?.close();
    await removeUploadFile(partPath);
    if (installed) await removeUploadFile(finalPath);
    throw error;
  }
  return { sizeBytes: size, digest: hash.digest('hex') };
}

async function removeUploadFile(path: string, capacity?: Capacity) {
  try {
    if (capacity) await capacity.remove(path);
    else await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/** Before mounting ingress, repair only this node's unpublished originals. */
export async function recoverLocalUploads(tenant: Tenant, capacity?: Capacity) {
  const issuer = localIssuer();
  if (issuer === null) return;
  const root = mediaRoot();
  let changed = false;
  try {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isFile) continue;
      const part = /^([^.]+)\.[a-f0-9-]{36}\.part$/.exec(entry.name);
      const id = part?.[1] ?? entry.name;
      if (!mediaIssuedBy(id, issuer)) continue;
      // Publication intent and uploaded state are committed together. A final
      // without an uploaded row cannot have reached an upload ACK.
      if (!part && (await getMedia(tenant, id))?.state === 'uploaded') continue;
      await removeUploadFile(`${root}/${entry.name}`, capacity);
      changed = true;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (changed) {
    const directory = await Deno.open(root, { read: true });
    try {
      await directory.sync();
    } finally {
      directory.close();
    }
  }
}

export async function serveMedia(
  mxcServerName: string,
  mediaId: string,
): Promise<Response> {
  assertLocalMxc(mxcServerName, mediaId);
  const row = await theApp().tenant.tx(async (tx) => {
    const row = await tx.media.byId(mediaId);
    if (
      row === null && config().server.role === 'home' &&
      mediaId.startsWith('n1_') && await tx.media.homeCopy(mediaId)
    ) {
      throw new MatrixError(503, 'M_UNAVAILABLE', 'Media copy unavailable');
    }
    return row;
  });
  if (row === null) {
    const issuer = localIssuer();
    if (issuer !== null && !mediaIssuedBy(mediaId, issuer)) {
      // Not enough information to rule out an existing original at home.
      throw new MatrixError(503, 'M_UNAVAILABLE', 'Media unavailable');
    }
    throw new MatrixError(404, 'M_NOT_FOUND', 'Unknown media');
  }
  if (row.state !== 'uploaded') {
    if (Date.now() >= row.created_ms + RESERVATION_MS) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'Media reservation expired');
    }
    throw new MatrixError(
      504,
      'M_NOT_YET_UPLOADED',
      'Content is not yet available',
    );
  }
  const file = await Deno.open(`${mediaRoot()}/${mediaId}`, { read: true })
    .catch((error) => {
      if (error instanceof Deno.errors.NotFound) {
        throw new MatrixError(503, 'M_UNAVAILABLE', 'Media bytes unavailable');
      }
      throw error;
    });
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
