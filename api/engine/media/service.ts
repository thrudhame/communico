// Authenticated demand-only remote media. One cache owner, one signed federation
// transport and the shared CA-only TLS owner for untrusted external Locations.
import { config, serverName } from '#engine/config.ts';
import { admit } from '#engine/federation/gate.ts';
import {
  caCertsPem,
  FederationHttpError,
  federationRequestRaw,
} from '#engine/federation/client.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { serverAllowed } from '#engine/room/acl.ts';
import type { Database as Db } from '#engine/store/db.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { contentDisposition, serveMedia } from '#engine/media.ts';
import { type ByteMetadata, type CacheIdentity, MediaCache } from './cache.ts';
import { fetchLocation } from './location.ts';
import {
  MEDIA_ENVELOPE_LIMIT,
  mediaMultipart,
  type MediaPart,
} from './multipart.ts';
import { type Thumbnail, ThumbnailWorkers } from './thumbnail.ts';

function assertMxc(origin: string, mediaId: string) {
  if (!serverAllowed(origin, null) || !/^[A-Za-z0-9_-]{1,255}$/.test(mediaId)) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'Unknown media');
  }
}
export function safeFilename(value: string | null): string | null {
  if (value === null) return null;
  const safe = Array.from(
    value.toWellFormed(),
    (c) =>
      c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '/' || c === '\\'
        ? '_'
        : c,
  ).join('').slice(0, 255);
  return safe.length ? safe : null;
}
function filenameOf(disposition: string | null): string | null {
  if (disposition === null) return null;
  const extended = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]*)/i.exec(
    disposition,
  );
  if (extended) {
    try {
      return safeFilename(decodeURIComponent(extended[1]));
    } catch {
      return null;
    }
  }
  const match = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i
    .exec(disposition);
  return safeFilename(
    match ? (match[1] ?? match[2]).replace(/\\(.)/g, '$1').trim() : null,
  );
}
function safeType(value: string): string {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;[^\r\n\0]*)?$/
      .test(value)
    ? value
    : 'application/octet-stream';
}
function responseHeaders(
  type: string,
  filename: string | null,
  size: number,
): Headers {
  return new Headers({
    'Content-Type': safeType(type),
    'Content-Disposition': contentDisposition(type, safeFilename(filename)),
    'Content-Length': String(size),
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Content-Security-Policy':
      "sandbox; default-src 'none'; script-src 'none'; object-src 'none';",
  });
}
export class MediaService {
  private cache: Promise<MediaCache> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private thumbnails = new ThumbnailWorkers();
  constructor(private db: Db, private tenant: Tenant) {}
  private cacheOwner(): Promise<MediaCache> {
    if (this.cache === null) {
      const owner = (async () => {
        const cache = new MediaCache(
          this.db,
          config().media.root,
          config().media.maxvariants,
        );
        try {
          await cache.start();
          await cache.cleanup(config().media.cache);
          this.timer = setInterval(() => {
            void cache.cleanup(config().media.cache).catch((error) =>
              console.error('media cache maintenance failed:', error)
            );
          }, config().media.cleanupseconds * 1000);
          return cache;
        } catch (error) {
          await cache.close();
          throw error;
        }
      })();
      this.cache = owner;
      void owner.catch(() => {
        if (this.cache === owner) this.cache = null;
      });
    }
    return this.cache;
  }
  async close(): Promise<void> {
    this.thumbnails.close();
    if (this.timer !== null) clearInterval(this.timer);
    if (this.cache !== null) {
      const cache = await this.cache;
      if (this.timer !== null) clearInterval(this.timer);
      await cache.close();
    }
  }
  async download(
    origin: string,
    mediaId: string,
    user: string,
    filename: string | null = null,
    allowRemote = true,
    signal?: AbortSignal,
  ): Promise<Response> {
    signal?.throwIfAborted();
    assertMxc(origin, mediaId);
    if (origin === serverName()) {
      const response = await serveMedia(origin, mediaId);
      if (filename !== null) {
        response.headers.set(
          'Content-Disposition',
          contentDisposition(
            response.headers.get('content-type') ?? 'application/octet-stream',
            safeFilename(filename),
          ),
        );
      }
      return response;
    }
    if (!config().federation.enabled) {
      throw new MatrixError(502, 'M_UNKNOWN', 'federation disabled');
    }
    // Repeat policy on hits. User-authenticated media intent is not anonymous proxying.
    await admit(this.db, origin, {
      kind: 'outbound',
      user,
      what: 'media download',
    });
    const cache = await this.cacheOwner();
    const identity: CacheIdentity = {
      origin,
      mediaId,
      variant: 'original',
      scope: 'remote',
    };
    let row = await cache.get(identity);
    if (row === null) {
      if (!allowRemote) {
        throw new MatrixError(404, 'M_NOT_FOUND', 'Unknown cached media');
      }
      row = await cache.fetch(
        identity,
        config().media.maxfetches,
        (output, signal) => this.remote(origin, mediaId, output, signal),
        signal,
      );
    }
    // Network work may yield while the origin is blocked by the operator.
    await admit(this.db, origin, {
      kind: 'outbound',
      user,
      what: 'media download',
    });
    const stream = await cache.open(row);
    try {
      await cache.cleanup(config().media.cache);
    } catch (error) {
      await stream.cancel(error);
      throw error;
    }
    return new Response(stream, {
      headers: responseHeaders(
        row.content_type,
        filename === null ? row.filename : filename,
        row.size,
      ),
    });
  }
  async thumbnail(
    origin: string,
    mediaId: string,
    user: string,
    options: Thumbnail,
    allowRemote = true,
    legacy = false,
    signal?: AbortSignal,
  ): Promise<Response> {
    signal?.throwIfAborted();
    assertMxc(origin, mediaId);
    if (legacy && origin !== serverName()) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'Unknown media');
    }
    if (origin !== serverName()) {
      if (!config().federation.enabled) {
        throw new MatrixError(502, 'M_UNKNOWN', 'federation disabled');
      }
      await admit(this.db, origin, {
        kind: 'outbound',
        user,
        what: 'media thumbnail',
      });
    } else {
      // Validate current local upload state even on a derived-cache hit.
      const original = await serveMedia(origin, mediaId);
      await original.body?.cancel();
    }
    const cache = await this.cacheOwner();
    const identity: CacheIdentity = {
      origin,
      mediaId,
      variant:
        `png:v1:${options.method}:${options.width}:${options.height}:${options.animated}`,
      scope: 'thumbnail',
    };
    let row = await cache.get(identity);
    if (row === null) {
      if (!allowRemote && origin !== serverName()) {
        throw new MatrixError(404, 'M_NOT_FOUND', 'Unknown cached thumbnail');
      }
      row = await cache.fetch(
        identity,
        config().media.maxfetches,
        async (output, signal) => {
          const policy = config().media;
          const bytes = await this.thumbnails.render(
            async () => {
              if (origin === serverName()) {
                const original = await serveMedia(origin, mediaId);
                return await boundedBytes(original.body!, policy.maxbytes);
              }
              // Remote thumbnail inputs are buffered only *after* obtaining a worker
              // slot: at most thumbnailworkers x maxbytes compressed input, plus the
              // bounded decode buffers. Ordinary downloads remain disk-streamed.
              const chunks: Uint8Array[] = [];
              let size = 0;
              await this.remote(
                origin,
                mediaId,
                new WritableStream({
                  write(chunk) {
                    chunks.push(chunk.slice());
                    size += chunk.length;
                  },
                }),
                signal,
                options,
              );
              const result = new Uint8Array(size);
              let at = 0;
              for (const chunk of chunks) {
                result.set(chunk, at);
                at += chunk.length;
              }
              return result;
            },
            options,
            policy,
            signal,
          );
          const writer = output.getWriter();
          try {
            await writer.write(bytes);
            await writer.close();
          } catch (error) {
            await writer.abort(error).catch(() => {});
            throw error;
          }
          return {
            contentType: 'image/png',
            filename: null,
            size: bytes.length,
          };
        },
        signal,
      );
    }
    if (origin !== serverName()) {
      await admit(this.db, origin, {
        kind: 'outbound',
        user,
        what: 'media thumbnail',
      });
    }
    const stream = await cache.open(row);
    try {
      await cache.cleanup(config().media.cache);
    } catch (error) {
      await stream.cancel(error);
      throw error;
    }
    return new Response(stream, {
      headers: responseHeaders('image/png', null, row.size),
    });
  }
  private async remote(
    origin: string,
    mediaId: string,
    output: WritableStream<Uint8Array>,
    parentSignal: AbortSignal,
    thumbnail?: Thumbnail,
  ): Promise<ByteMetadata> {
    const policy = config().media;
    const signal = AbortSignal.any([
      parentSignal,
      AbortSignal.timeout(policy.timeoutms),
    ]);
    const writer = output.getWriter();
    let size = 0;
    const target = () =>
      new WritableStream<Uint8Array>({
        write: async (chunk) => {
          size += chunk.length;
          if (size > policy.maxbytes) {
            throw new MatrixError(
              502,
              'M_TOO_LARGE',
              'Remote media exceeds the server limit',
            );
          }
          await writer.write(chunk);
        },
      });
    let part: MediaPart | null = null;
    const query = thumbnail === undefined ? '' : '?' +
      new URLSearchParams({
        width: String(thumbnail.width),
        height: String(thumbnail.height),
        method: thumbnail.method,
        animated: String(thumbnail.animated),
      });
    const kind = thumbnail === undefined ? 'download' : 'thumbnail';
    try {
      try {
        await federationRequestRaw(this.db, this.tenant.signer(), {
          destination: origin,
          method: 'GET',
          path: '/_matrix/federation/v1/media/' + kind + '/' +
            encodeURIComponent(mediaId) + query,
          body: null,
          maxBytes: policy.maxbytes + MEDIA_ENVELOPE_LIMIT,
          signal,
          sink: (status, headers) => {
            if (status !== 200) throw new Error('invalid media success status');
            const parser = mediaMultipart(
              headers.get('content-type') ?? '',
              target(),
              policy.maxbytes,
            );
            part = parser.result;
            return parser.stream;
          },
        });
      } catch (error) {
        // Only this completed wire response authorizes downgrade. Never a mapped
        // local error, bare HTML404, M_NOT_FOUND, auth refusal or malformed body.
        if (
          !(error instanceof FederationHttpError) ||
          error.remoteStatus !== 404 || !error.matrixBody ||
          error.errcode !== 'M_UNRECOGNIZED'
        ) throw error;
        const response = await federationRequestRaw(
          this.db,
          this.tenant.signer(),
          {
            destination: origin,
            method: 'GET',
            path: '/_matrix/media/v3/' + kind + '/' +
              encodeURIComponent(origin) +
              '/' + encodeURIComponent(mediaId) + (query ? query + '&' : '?') +
              'allow_remote=false',
            body: null,
            maxBytes: policy.maxbytes,
            signal,
            sink: (status, headers) => {
              if (status !== 200) {
                throw new Error('invalid media success status');
              }
              part = {
                contentType: headers.get('content-type') ??
                  'application/octet-stream',
                disposition: headers.get('content-disposition'),
                location: null,
                size: 0,
              };
              return target();
            },
          },
        );
        if (response.status !== 200) {
          throw new Error('invalid media fallback status');
        }
      }
      const received = part as MediaPart | null;
      if (received === null) throw new Error('missing media envelope');
      let content = received;
      if (received.location !== null) {
        content = await fetchLocation(received.location, target(), signal, {
          maxBytes: policy.maxbytes,
          timeoutMs: policy.timeoutms,
          maxRedirects: policy.maxredirects,
          blocklist: policy.blocklist,
          allowlist: policy.allowlist,
          caCerts: caCertsPem(),
        });
      }
      await writer.close();
      return {
        contentType: safeType(content.contentType),
        filename: filenameOf(content.disposition),
        size,
      };
    } catch (error) {
      await writer.abort(error).catch(() => {});
      throw error;
    }
  }
}

async function boundedBytes(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new MatrixError(413, 'M_TOO_LARGE', 'Image exceeds byte limit');
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}
