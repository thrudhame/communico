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
  constructor(private db: Db, private tenant: Tenant) {}
  private cacheOwner(): Promise<MediaCache> {
    if (this.cache === null) {
      this.cache = (async () => {
        const cache = new MediaCache(this.db, config().media.root);
        await cache.start();
        await cache.cleanup(config().media.cache);
        this.timer = setInterval(() => {
          void cache.cleanup(config().media.cache).catch((error) =>
            console.error('media cache maintenance failed:', error)
          );
        }, config().media.cleanupseconds * 1000);
        return cache;
      })();
    }
    return this.cache;
  }
  async close(): Promise<void> {
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
  ): Promise<Response> {
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
  private async remote(
    origin: string,
    mediaId: string,
    output: WritableStream<Uint8Array>,
    parentSignal: AbortSignal,
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
    try {
      try {
        await federationRequestRaw(this.db, this.tenant.signer(), {
          destination: origin,
          method: 'GET',
          path: '/_matrix/federation/v1/media/download/' +
            encodeURIComponent(mediaId),
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
            path: '/_matrix/media/v3/download/' + encodeURIComponent(origin) +
              '/' + encodeURIComponent(mediaId) + '?allow_remote=false',
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
