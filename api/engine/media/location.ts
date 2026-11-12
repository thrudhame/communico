import {
  dialNodeTls,
  type DialOpts,
} from '#engine/federation/dial-node-tls.ts';
import { abortable } from '#engine/net/abort.ts';
import { cidrContains, parseCidr, parseIp } from '#engine/preview/cidr.ts';
import type { MediaPart } from './multipart.ts';
import {
  limit,
  protocol,
  upstreamDeadline,
  UpstreamError,
  UpstreamHttpError,
} from '#engine/net/upstream-error.ts';

export type LocationPolicy = {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  blocklist: string[];
  allowlist: string[];
  caCerts: string[];
};
type Deps = {
  resolve?: (host: string, signal: AbortSignal) => Promise<string[]>;
  dial?: typeof dialNodeTls;
};
async function resolve(host: string, signal: AbortSignal): Promise<string[]> {
  if (parseIp(host)) return [host];
  const addresses = await Promise.all(['A', 'AAAA'].map(async (rr) => {
    try {
      return await Deno.resolveDns(host, rr as 'A' | 'AAAA', { signal });
    } catch {
      signal.throwIfAborted();
      return [];
    }
  }));
  return addresses.flat();
}

/** External CDN URLs use CA-only TLS, not federation roster trust. The caller
 * supplies only a byte destination, never headers, credentials or cookies. */
export async function fetchLocation(
  rawUrl: string,
  output: WritableStream<Uint8Array>,
  signal: AbortSignal,
  policy: LocationPolicy,
  deps: Deps = {},
): Promise<MediaPart> {
  const bounded = upstreamDeadline(signal, policy.timeoutMs);
  const allowed = policy.allowlist.map((c) => parseCidr(c)!);
  const blocked = policy.blocklist.map((c) => parseCidr(c)!);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    protocol('media-location', 'invalid media Location');
  }
  let budget = policy.maxBytes;
  for (let hop = 0; hop <= policy.maxRedirects; hop++) {
    bounded.throwIfAborted();
    if (
      url.protocol !== 'https:' || url.username || url.password || url.hash ||
      url.href.length > 8192
    ) {
      throw new UpstreamError('validation', {
        phase: 'media-location',
        reason: 'media Location refused by HTTPS/credential/fragment policy',
      });
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const ips = await abortable(
      bounded,
      () => (deps.resolve ?? resolve)(host, bounded),
    );
    if (!ips.length) {
      throw new UpstreamError('transport', {
        phase: 'dns',
        reason: 'media Location has no address',
      });
    }
    for (const ip of ips) {
      if (
        !parseIp(ip) ||
        (!allowed.some((c) => cidrContains(c, ip)) &&
          blocked.some((c) => cidrContains(c, ip)))
      ) {
        throw new UpstreamError('validation', {
          phase: 'media-location',
          reason: 'media Location address blocked',
        });
      }
    }
    let size = 0;
    const opts: DialOpts = {
      connectIp: ips[0],
      port: url.port ? Number(url.port) : 443,
      sni: parseIp(host) ? null : host,
      hostHeader: url.host,
      trust: { kind: 'ca', caCerts: policy.caCerts },
      method: 'GET',
      path: url.pathname + url.search,
      headers: { Accept: '*/*' },
      body: null,
      connectMs: Math.min(5000, policy.timeoutMs),
      timeoutMs: policy.timeoutMs,
      maxBytes: budget,
      signal: bounded,
      sink: (status) => {
        const writer = status === 200 ? output.getWriter() : null;
        return new WritableStream<Uint8Array>({
          async write(chunk) {
            size += chunk.length;
            budget -= chunk.length;
            if (budget < 0 || (writer === null && size > 16384)) {
              limit('media-location', 'media Location response too large');
            }
            if (writer) await writer.write(chunk);
          },
          async close() {
            if (writer) await writer.close();
          },
          async abort(reason) {
            if (writer) await writer.abort(reason);
          },
        });
      },
    };
    const response = await abortable(
      bounded,
      () => (deps.dial ?? dialNodeTls)(opts),
    );
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location');
      if (next === null) {
        protocol('media-location', 'media Location redirect has no target');
      }
      try {
        url = new URL(next, url);
      } catch {
        protocol('media-location', 'invalid media Location redirect');
      }
      continue;
    }
    if (response.status !== 200) {
      throw new UpstreamHttpError(response.status, 'media-location');
    }
    return {
      contentType: response.headers.get('content-type') ??
        'application/octet-stream',
      disposition: response.headers.get('content-disposition'),
      location: null,
      size,
    };
  }
  limit('media-location', 'too many media Location redirects');
}
