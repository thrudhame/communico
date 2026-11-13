// Push uses the existing TLS socket owner in CA-only mode, never federation
// roster trust. Resolve/check/connect one address identity; do not follow redirects.
import {
  dialNodeTls,
  type DialOpts,
} from '#engine/federation/dial-node-tls.ts';
import { abortable } from '#engine/net/abort.ts';
import { config } from '#engine/config.ts';
import { cidrContains, parseCidr, parseIp } from '#engine/preview/cidr.ts';
import { gatewayUrl } from './registration.ts';
import { arrayOf, decodeJson, objectOf, stringOf } from '#engine/net/json.ts';
import {
  limit,
  upstreamDeadline,
  UpstreamError,
  UpstreamHttpError,
} from '#engine/net/upstream-error.ts';

export type GatewayPolicy = {
  blocklist: string[];
  allowlist: string[];
  caCerts: string[];
  timeoutMs: number;
};
type Deps = {
  resolve?: (host: string, signal: AbortSignal) => Promise<string[]>;
  dial?: typeof dialNodeTls;
};

export function gatewayPolicy(): GatewayPolicy {
  const p = config().push;
  return {
    blocklist: p.blocklist,
    allowlist: p.allowlist,
    caCerts: p.cacerts.map((path) => Deno.readTextFileSync(path)),
    timeoutMs: 10000,
  };
}

async function resolve(host: string, signal: AbortSignal): Promise<string[]> {
  if (parseIp(host)) return [host];
  const out = await Promise.all(['A', 'AAAA'].map(async (rr) => {
    try {
      return await Deno.resolveDns(host, rr as 'A' | 'AAAA', { signal });
    } catch {
      signal.throwIfAborted();
      return [];
    }
  }));
  return out.flat();
}

/** A verdict is only a bounded, valid HTTP200 rejected array. Transport errors
 * remain retryable work; neither redirects nor arbitrary status codes delete keys. */
export async function sendGateway(
  rawUrl: string,
  payload: unknown,
  signal: AbortSignal,
  policy: GatewayPolicy = gatewayPolicy(),
  deps: Deps = {},
): Promise<string[]> {
  const url = gatewayUrl(rawUrl);
  const body = new TextEncoder().encode(JSON.stringify(payload));
  if (body.length > 262144) limit('push', 'push request exceeds 256 KiB');
  const bounded = upstreamDeadline(signal, policy.timeoutMs);
  bounded.throwIfAborted();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ips = await abortable(
    bounded,
    () => (deps.resolve ?? resolve)(host, bounded),
  );
  if (!ips.length) {
    throw new UpstreamError('transport', {
      phase: 'dns',
      reason: 'gateway has no address',
    });
  }
  const allowed = policy.allowlist.map((s) => parseCidr(s)!);
  const blocked = policy.blocklist.map((s) => parseCidr(s)!);
  for (const ip of ips) {
    if (
      !parseIp(ip) ||
      (!allowed.some((c) => cidrContains(c, ip)) &&
        blocked.some((c) => cidrContains(c, ip)))
    ) {
      throw new UpstreamError('validation', {
        phase: 'push-policy',
        reason: 'gateway address blocked by push policy',
      });
    }
  }
  const opts: DialOpts = {
    connectIp: ips[0],
    port: url.port ? Number(url.port) : 443,
    sni: parseIp(host) ? null : host,
    hostHeader: url.host,
    trust: { kind: 'ca', caCerts: policy.caCerts },
    method: 'POST',
    path: url.pathname + url.search,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
    connectMs: Math.min(5000, policy.timeoutMs),
    timeoutMs: policy.timeoutMs,
    maxBytes: 65536,
    signal: bounded,
  };
  const response = await abortable(
    bounded,
    () => (deps.dial ?? dialNodeTls)(opts),
  );
  if (response.status !== 200) {
    throw new UpstreamHttpError(response.status, 'push');
  }
  const json = objectOf(
    decodeJson(response.body, response.headers.get('content-type')),
    'push',
  );
  return arrayOf(json.rejected, (key) => stringOf(key, 'push'), 'push');
}
