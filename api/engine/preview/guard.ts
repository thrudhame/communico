// api/engine/preview/guard.ts — resolve-then-check every hop, then
// connect to a checked IP. HTTP: Host header = original hostname.
// HTTPS: Deno.connect to the IP, Deno.startTls({ hostname }) so SNI and
// cert verification use the name, not the address. Never fetch(url) by
// hostname. Max 5 redirects; 10 s per hop; size cap streamed.
// The connection mechanics live in #engine/net/http1.ts — this file is
// the SSRF policy on top.
import { MatrixError } from '#engine/matrix-error.ts';
import { http1Request } from '#engine/net/http1.ts';
import { type Cidr, cidrContains, parseCidr, parseIp } from './cidr.ts';

export type GuardOpts = {
  maxBytes: number;
  blocklist: string[];
  allowlist: string[];
  acceptLanguage: string | null;
};

export type GuardedBody = {
  status: number;
  headers: Headers;
  body: Uint8Array;
  url: string;
  contentType: string;
};

const MAX_REDIRECTS = 5;
const HOP_MS = 10_000;

function blocked(ip: string, block: Cidr[], allow: Cidr[]): boolean {
  for (const c of allow) {
    if (cidrContains(c, ip)) return false;
  }
  for (const c of block) {
    if (cidrContains(c, ip)) return true;
  }
  return false;
}

async function resolveAll(host: string): Promise<string[]> {
  const literal = parseIp(host);
  if (literal !== null) return [host];
  const out: string[] = [];
  try {
    out.push(...await Deno.resolveDns(host, 'A'));
  } catch { /* no A */ }
  try {
    out.push(...await Deno.resolveDns(host, 'AAAA'));
  } catch { /* no AAAA */ }
  return out;
}

function defaultPort(https: boolean): number {
  return https ? 443 : 80;
}

function requestPath(u: URL): string {
  return u.pathname + u.search;
}

function hostHeader(u: URL, https: boolean): string {
  if (u.port === '') return u.hostname;
  const def = defaultPort(https);
  if (Number(u.port) === def) return u.hostname;
  return u.hostname + ':' + u.port;
}

async function hopGet(
  rawUrl: string,
  hop: number,
  opts: GuardOpts,
  block: Cidr[],
  allow: Cidr[],
): Promise<GuardedBody> {
  if (hop > MAX_REDIRECTS) {
    throw new MatrixError(502, 'M_UNKNOWN', 'too many redirects');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'invalid url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'url scheme must be http or https',
    );
  }
  const https = parsed.protocol === 'https:';
  const addrs = await resolveAll(parsed.hostname);
  if (addrs.length === 0) {
    throw new MatrixError(502, 'M_UNKNOWN', 'could not resolve hostname');
  }
  for (const ip of addrs) {
    if (blocked(ip, block, allow)) {
      throw new MatrixError(
        403,
        'M_FORBIDDEN',
        'URL blocked by preview policy',
      );
    }
  }
  const ip = addrs[0];
  const port = parsed.port === '' ? defaultPort(https) : Number(parsed.port);
  const lang = opts.acceptLanguage;
  const headers: Record<string, string> = { Accept: '*/*' };
  if (lang !== null && lang.length > 0) {
    headers['Accept-Language'] = lang;
  }
  const res = await http1Request({
    connectIp: ip,
    port,
    tls: https ? { sni: parsed.hostname, caCerts: [] } : null,
    hostHeader: hostHeader(parsed, https),
    method: 'GET',
    path: requestPath(parsed),
    headers,
    body: null,
    connectMs: HOP_MS,
    timeoutMs: HOP_MS,
    maxBytes: opts.maxBytes,
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (loc === null || loc.length === 0) {
      throw new MatrixError(502, 'M_UNKNOWN', 'redirect without Location');
    }
    const next = new URL(loc, parsed).href;
    return await hopGet(next, hop + 1, opts, block, allow);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new MatrixError(
      502,
      'M_UNKNOWN',
      'upstream returned ' + res.status,
    );
  }
  const ct = res.headers.get('content-type');
  return {
    status: res.status,
    headers: res.headers,
    body: res.body,
    url: parsed.href,
    contentType: ct !== null ? ct : 'application/octet-stream',
  };
}

export async function guardedGet(
  url: string,
  opts: GuardOpts,
): Promise<GuardedBody> {
  const block: Cidr[] = [];
  for (const s of opts.blocklist) {
    const c = parseCidr(s);
    if (c !== null) block.push(c);
  }
  const allow: Cidr[] = [];
  for (const s of opts.allowlist) {
    const c = parseCidr(s);
    if (c !== null) allow.push(c);
  }
  return await hopGet(url, 0, opts, block, allow);
}
