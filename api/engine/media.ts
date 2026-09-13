// api/engine/media.ts — the media engine (M2, plan §3.4): bytes on disk
// under MEDIA_ROOT, metadata in the tenant DB (media table). One source
// for media-id minting, mxc sanitisation, upload streaming, and the
// download headers. Spec target: Matrix v1.16 (amendment-1).
import { required, serverName } from './config.ts';
import { getMedia } from './tenant.ts';
import { MatrixError } from './matrix-error.ts';

let _mediaRoot: string | undefined;

/** The media-byte root directory (memoized; created at startup). */
export function mediaRoot(): string {
  return (_mediaRoot ??= required('MEDIA_ROOT'));
}

/** The upload limit in bytes (advertised as `m.upload.size`). */
export function mediaMaxBytes(): number {
  return Number(required('MEDIA_MAX_BYTES'));
}

/** A new media id: 24 base64url chars from 18 random bytes (plan §3.4). */
export function newMediaId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Spec v1.16, Content repository — Security considerations: "homeservers
// MUST sanitise mxc:// URIs by allowing only alphanumeric (A-Za-z0-9), _
// and - characters in the server-name and media-id values" — a whitelist,
// never a blacklist of . and / (percent-encoding and UTF-8 traversal
// tricks defeat blacklists).
// https://spec.matrix.org/v1.16/client-server-api/#content-repository-security
const MXC_COMPONENT = /^[A-Za-z0-9_-]+$/;

/**
 * 404 M_NOT_FOUND unless both mxc components are whitelist-clean AND the
 * server name is ours (no federation fetch in M2). Never touch the
 * filesystem or the DB with an unvalidated id.
 */
export function assertLocalMxc(mxcServerName: string, mediaId: string): void {
  if (
    !MXC_COMPONENT.test(mxcServerName) || !MXC_COMPONENT.test(mediaId) ||
    mxcServerName !== serverName()
  ) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'Unknown media');
  }
}

// Spec v1.16, Serving inline content: "Servers SHOULD restrict
// Content-Type headers to one of the following values when serving
// content with Content-Disposition: inline" — transcribed verbatim.
// https://spec.matrix.org/v1.16/client-server-api/#serving-inline-content
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

/** RFC 6266 filename parameter: quoted ASCII, else RFC 5987 `filename*`. */
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

/**
 * Content-Disposition per spec v1.16 (required header since v1.12): "MUST
 * be one of `inline` or `attachment`, and SHOULD contain a file name. If
 * the `Content-Type` is allowed in the restrictions for serving inline
 * content, servers SHOULD use `inline`, otherwise they SHOULD use
 * `attachment`." Computed from the STORED content type (amendment-1 B.2:
 * "there is no risk in trusting the user-defined content type, as long as
 * the Content-Disposition is calculated based on that type"); the stored
 * filename is appended when present, omitted when not.
 * https://spec.matrix.org/v1.16/client-server-api/#get_matrixclientv1mediadownloadservernamemediaid
 */
export function contentDisposition(
  contentType: string,
  filename: string | null,
): string {
  const mediaType = (contentType.split(';')[0] ?? contentType).trim().toLowerCase();
  const disposition = INLINE_CONTENT_TYPES.includes(mediaType) ? 'inline' : 'attachment';
  return filename === null ? disposition : `${disposition}; ${filenameParameter(filename)}`;
}

/**
 * Stream an upload body to `${MEDIA_ROOT}/${mediaId}.part`, counting
 * bytes; over `MEDIA_MAX_BYTES` → abort, delete the part, 413 M_TOO_LARGE
 * (plan §3.4; spec v1.16: "Homeservers should not store files that are
 * too large … returning a HTTP 413 error with the M_TOO_LARGE code").
 * Success renames the part to the final path and returns the size. Shared
 * by the direct upload POST and the async PUT.
 */
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
          throw new MatrixError(413, 'M_TOO_LARGE', 'Upload exceeds the server limit');
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

/**
 * Serve stored media bytes (plan §3.4). Foreign server or unknown id →
 * 404 M_NOT_FOUND (no federation fetch in M2); pending → 504
 * M_NOT_YET_UPLOADED (spec v1.16: "The content is not yet available").
 * Headers: the stored Content-Type verbatim (Complement M1/M2 assert the
 * exact echo), Content-Length, the computed Content-Disposition, and the
 * spec's recommended CSP + CORP:
 * https://spec.matrix.org/v1.16/client-server-api/#content-repository
 */
export async function serveMedia(
  mxcServerName: string,
  mediaId: string,
): Promise<Response> {
  assertLocalMxc(mxcServerName, mediaId);
  const row = await getMedia(serverName(), mediaId);
  if (row === null) throw new MatrixError(404, 'M_NOT_FOUND', 'Unknown media');
  if (row.state !== 'uploaded') {
    throw new MatrixError(504, 'M_NOT_YET_UPLOADED', 'Content is not yet available');
  }
  const file = await Deno.open(`${mediaRoot()}/${mediaId}`, { read: true });
  const contentType = row.content_type ?? 'application/octet-stream';
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Disposition': contentDisposition(contentType, row.filename),
    // Spec v1.16 recommended policy, verbatim: "The recommended policy is
    // sandbox; default-src 'none'; script-src 'none'; plugin-types
    // application/pdf; style-src 'unsafe-inline'; object-src 'self';"
    'Content-Security-Policy':
      "sandbox; default-src 'none'; script-src 'none'; plugin-types application/pdf; style-src 'unsafe-inline'; object-src 'self';",
    // Spec v1.16 (added v1.4): lets (web) clients access restricted APIs
    // such as SharedArrayBuffer when interacting with the media repo.
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  if (row.size_bytes !== null) headers.set('Content-Length', String(row.size_bytes));
  return new Response(file.readable, { headers });
}
