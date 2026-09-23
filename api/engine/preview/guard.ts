// api/engine/preview/guard.ts — resolve-then-check every hop, then
// connect to a checked IP. HTTP: Host header = original hostname.
// HTTPS: Deno.connect to the IP, Deno.startTls({ hostname }) so SNI and
// cert verification use the name, not the address. Never fetch(url) by
// hostname. Max 5 redirects; 10 s per hop; size cap streamed.
import { MatrixError } from '../matrix-error.ts';
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
const HEADER_CAP = 64 * 1024;

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

function connectHost(ip: string): string {
  if (ip.includes(':') && !ip.startsWith('[')) return '[' + ip + ']';
  return ip;
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

async function readAtLeast(
  conn: Deno.Conn,
  buf: Uint8Array,
  filled: number,
  want: number,
): Promise<number> {
  let n = filled;
  while (n < want) {
    const got = await conn.read(buf.subarray(n));
    if (got === null) break;
    n += got;
  }
  return n;
}

async function readHttp(
  conn: Deno.Conn,
  maxBytes: number,
): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
  const headBuf = new Uint8Array(HEADER_CAP);
  let n = 0;
  let sep = -1;
  while (n < HEADER_CAP) {
    const got = await conn.read(headBuf.subarray(n));
    if (got === null) break;
    n += got;
    const text = new TextDecoder('latin1').decode(headBuf.subarray(0, n));
    sep = text.indexOf('\r\n\r\n');
    if (sep >= 0) break;
  }
  if (sep < 0) {
    throw new MatrixError(502, 'M_UNKNOWN', 'upstream headers too large');
  }
  const headText = new TextDecoder('latin1').decode(
    headBuf.subarray(0, sep),
  );
  const leftover = headBuf.subarray(sep + 4, n);
  const lines = headText.split('\r\n');
  const statusLine = lines[0];
  const sm = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
  if (sm === null) {
    throw new MatrixError(502, 'M_UNKNOWN', 'bad upstream status line');
  }
  const status = Number(sm[1]);
  const headers = new Headers();
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon < 0) continue;
    headers.append(
      lines[i].slice(0, colon).trim(),
      lines[i].slice(colon + 1).trim(),
    );
  }
  const clRaw = headers.get('content-length');
  if (clRaw !== null) {
    const cl = Number(clRaw);
    if (!Number.isFinite(cl) || cl < 0) {
      throw new MatrixError(502, 'M_UNKNOWN', 'bad content-length');
    }
    if (cl > maxBytes) {
      throw new MatrixError(502, 'M_TOO_LARGE', 'Content is too large');
    }
    const body = new Uint8Array(cl);
    body.set(leftover.subarray(0, Math.min(leftover.length, cl)));
    let filled = Math.min(leftover.length, cl);
    filled = await readAtLeast(conn, body, filled, cl);
    if (filled < cl) {
      throw new MatrixError(502, 'M_UNKNOWN', 'upstream body truncated');
    }
    return { status, headers, body };
  }
  const te = headers.get('transfer-encoding');
  if (te !== null && te.toLowerCase().includes('chunked')) {
    return {
      status,
      headers,
      body: await readChunked(conn, leftover, maxBytes),
    };
  }
  const parts: Uint8Array[] = [];
  let total = leftover.length;
  if (total > maxBytes) {
    throw new MatrixError(502, 'M_TOO_LARGE', 'Content is too large');
  }
  if (leftover.length > 0) parts.push(new Uint8Array(leftover));
  const tmp = new Uint8Array(16 * 1024);
  while (total <= maxBytes) {
    const got = await conn.read(tmp);
    if (got === null) break;
    total += got;
    if (total > maxBytes) {
      throw new MatrixError(502, 'M_TOO_LARGE', 'Content is too large');
    }
    parts.push(tmp.slice(0, got));
  }
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    body.set(p, off);
    off += p.length;
  }
  return { status, headers, body };
}

async function readChunked(
  conn: Deno.Conn,
  leftover: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array> {
  let pending = leftover;
  const takeLine = async (): Promise<string> => {
    while (true) {
      const text = new TextDecoder('latin1').decode(pending);
      const idx = text.indexOf('\r\n');
      if (idx >= 0) {
        const line = text.slice(0, idx);
        pending = pending.subarray(idx + 2);
        return line;
      }
      const tmp = new Uint8Array(1024);
      const got = await conn.read(tmp);
      if (got === null) {
        throw new MatrixError(502, 'M_UNKNOWN', 'truncated chunked body');
      }
      const next = new Uint8Array(pending.length + got);
      next.set(pending);
      next.set(tmp.subarray(0, got), pending.length);
      pending = next;
      if (pending.length > HEADER_CAP) {
        throw new MatrixError(502, 'M_UNKNOWN', 'chunk size line too long');
      }
    }
  };
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const line = await takeLine();
    const size = parseInt(line.split(';', 1)[0], 16);
    if (!Number.isFinite(size) || size < 0) {
      throw new MatrixError(502, 'M_UNKNOWN', 'bad chunk size');
    }
    if (size === 0) break;
    total += size;
    if (total > maxBytes) {
      throw new MatrixError(502, 'M_TOO_LARGE', 'Content is too large');
    }
    while (pending.length < size + 2) {
      const tmp = new Uint8Array(Math.max(size + 2 - pending.length, 1024));
      const got = await conn.read(tmp);
      if (got === null) {
        throw new MatrixError(502, 'M_UNKNOWN', 'truncated chunked body');
      }
      const next = new Uint8Array(pending.length + got);
      next.set(pending);
      next.set(tmp.subarray(0, got), pending.length);
      pending = next;
    }
    parts.push(pending.slice(0, size));
    pending = pending.subarray(size + 2);
  }
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    body.set(p, off);
    off += p.length;
  }
  return body;
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
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HOP_MS);
  let conn: Deno.Conn | null = null;
  try {
    const tcp = await Deno.connect({
      hostname: connectHost(ip),
      port,
      signal: ac.signal,
    });
    conn = tcp;
    let stream: Deno.Conn = tcp;
    if (https) {
      const tls = await Deno.startTls(tcp, { hostname: parsed.hostname });
      await tls.handshake();
      stream = tls;
      conn = tls;
    }
    const lang = opts.acceptLanguage;
    const req = 'GET ' + requestPath(parsed) + ' HTTP/1.1\r\n' +
      'Host: ' + hostHeader(parsed, https) + '\r\n' +
      'Accept: */*\r\n' +
      (lang !== null && lang.length > 0
        ? 'Accept-Language: ' + lang + '\r\n'
        : '') +
      'Connection: close\r\n\r\n';
    await stream.write(new TextEncoder().encode(req));
    const { status, headers, body } = await readHttp(stream, opts.maxBytes);
    if (status >= 300 && status < 400) {
      const loc = headers.get('location');
      if (loc === null || loc.length === 0) {
        throw new MatrixError(502, 'M_UNKNOWN', 'redirect without Location');
      }
      const next = new URL(loc, parsed).href;
      stream.close();
      conn = null;
      return await hopGet(next, hop + 1, opts, block, allow);
    }
    if (status < 200 || status >= 300) {
      throw new MatrixError(
        502,
        'M_UNKNOWN',
        'upstream returned ' + status,
      );
    }
    const ct = headers.get('content-type');
    return {
      status,
      headers,
      body,
      url: parsed.href,
      contentType: ct !== null ? ct : 'application/octet-stream',
    };
  } catch (e) {
    if (e instanceof MatrixError) throw e;
    if (ac.signal.aborted) {
      throw new MatrixError(502, 'M_UNKNOWN', 'upstream timeout');
    }
    throw new MatrixError(
      502,
      'M_UNKNOWN',
      'upstream connection failed',
    );
  } finally {
    clearTimeout(timer);
    if (conn !== null) {
      try {
        conn.close();
      } catch { /* already closed */ }
    }
  }
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
