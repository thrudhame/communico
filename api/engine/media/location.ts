import {
  dialNodeTls,
  type DialOpts,
} from '#engine/federation/dial-node-tls.ts';
import { abortable } from '#engine/net/abort.ts';
import { cidrContains, parseCidr, parseIp } from '#engine/preview/cidr.ts';
import type { MediaPart } from './multipart.ts';

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
  const bounded = AbortSignal.any([
    signal,
    AbortSignal.timeout(policy.timeoutMs),
  ]);
  const allowed = policy.allowlist.map((c) => parseCidr(c)!);
  const blocked = policy.blocklist.map((c) => parseCidr(c)!);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('invalid media Location');
  }
  let budget = policy.maxBytes;
  for (let hop = 0; hop <= policy.maxRedirects; hop++) {
    bounded.throwIfAborted();
    if (
      url.protocol !== 'https:' || url.username || url.password || url.hash ||
      url.href.length > 8192
    ) throw new Error('invalid media Location');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const ips = await abortable(
      bounded,
      () => (deps.resolve ?? resolve)(host, bounded),
    );
    if (!ips.length) throw new Error('media Location has no address');
    for (const ip of ips) {
      if (
        !parseIp(ip) ||
        (!allowed.some((c) => cidrContains(c, ip)) &&
          blocked.some((c) => cidrContains(c, ip)))
      ) throw new Error('media Location address blocked');
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
              throw new Error('media Location response too large');
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
        throw new Error('media Location redirect has no target');
      }
      try {
        url = new URL(next, url);
      } catch {
        throw new Error('invalid media Location redirect');
      }
      continue;
    }
    if (response.status !== 200) {
      throw new Error('media Location returned a non-200 response');
    }
    return {
      contentType: response.headers.get('content-type') ??
        'application/octet-stream',
      disposition: response.headers.get('content-disposition'),
      location: null,
      size,
    };
  }
  throw new Error('too many media Location redirects');
}
