// api/engine/net/http1.ts — HTTP/1.1 connection core, extracted from the
// preview guard (api/engine/preview/guard.ts) and generalised: any method,
// an optional request body, a TCP connect budget AND a whole-request
// budget. Connect by IP; TLS via Deno.startTls({ hostname: sni, caCerts })
// — for an IP peer `sni` is null and `hostname` is the IP (rustls verifies
// the IP SAN and sends no SNI). `caCerts` EXTENDS Deno's bundled webpki
// roots, never the OS store. Hand-written HTTP/1.1: Connection: close,
// Content-Length when a body is present, chunked + EOF response bodies,
// 64 KiB header cap. The total budget is enforced by closing the
// connection when it fires — a pending read then errors, and the error is
// reported as a timeout.
import { MatrixError } from '#engine/matrix-error.ts';

export type Http1Request = {
  connectIp: string;
  port: number;
  tls: { sni: string | null; caCerts: string[] } | null;
  hostHeader: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  connectMs: number;
  timeoutMs: number;
  maxBytes: number;
};

export type Http1Response = {
  status: number;
  headers: Headers;
  body: Uint8Array;
};

const HEADER_CAP = 64 * 1024;

function connectHost(ip: string): string {
  if (ip.includes(':') && !ip.startsWith('[')) return '[' + ip + ']';
  return ip;
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
): Promise<Http1Response> {
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

export async function http1Request(
  req: Http1Request,
): Promise<Http1Response> {
  const deadline = Date.now() + req.timeoutMs;
  let conn: Deno.Conn | null = null;
  // the whole-request budget: on fire, close the connection — a pending
  // read/handshake errors and is reported below as a timeout
  const totalTimer = setTimeout(
    () => {
      try {
        if (conn !== null) conn.close();
      } catch { /* already closed */ }
    },
    req.timeoutMs,
  );
  try {
    const ac = new AbortController();
    const connectTimer = setTimeout(
      () => ac.abort(),
      Math.min(req.connectMs, req.timeoutMs),
    );
    let tcp: Deno.TcpConn;
    try {
      tcp = await Deno.connect({
        hostname: connectHost(req.connectIp),
        port: req.port,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(connectTimer);
    }
    conn = tcp;
    let stream: Deno.Conn = tcp;
    if (req.tls !== null) {
      const tls = await Deno.startTls(tcp, {
        hostname: req.tls.sni !== null ? req.tls.sni : req.connectIp,
        caCerts: req.tls.caCerts,
      });
      await tls.handshake();
      stream = tls;
      conn = tls;
    }
    let head = req.method + ' ' + req.path + ' HTTP/1.1\r\n' +
      'Host: ' + req.hostHeader + '\r\n';
    for (const [name, value] of Object.entries(req.headers)) {
      head += name + ': ' + value + '\r\n';
    }
    if (req.body !== null) {
      head += 'Content-Length: ' + String(req.body.length) + '\r\n';
    }
    head += 'Connection: close\r\n\r\n';
    await stream.write(new TextEncoder().encode(head));
    if (req.body !== null) await stream.write(req.body);
    return await readHttp(stream, req.maxBytes);
  } catch (e) {
    if (e instanceof MatrixError) throw e;
    if (Date.now() >= deadline) {
      throw new MatrixError(502, 'M_UNKNOWN', 'upstream timeout');
    }
    throw new MatrixError(502, 'M_UNKNOWN', 'upstream connection failed');
  } finally {
    clearTimeout(totalTimer);
    if (conn !== null) {
      try {
        conn.close();
      } catch { /* already closed */ }
    }
  }
}
