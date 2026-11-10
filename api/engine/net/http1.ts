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
import { abortable } from '#engine/net/abort.ts';

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

export type Http1WireOpts = {
  method: string;
  path: string;
  hostHeader: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  maxBytes: number;
  // A sink is drained within the caller's transport lifetime/deadline. Null
  // keeps the bounded buffered result (for errors and existing JSON callers).
  sink?: (
    status: number,
    headers: Headers,
  ) => WritableStream<Uint8Array> | null;
  signal?: AbortSignal;
};

// The request/response half of http1Request, over ANY connection with the
// read/write/close shape — Deno.conns (plain and TLS) and the node:tls
// adapter for pinned/key-is-name peers satisfy it alike.
export type WireConn = {
  read: (p: Uint8Array) => Promise<number | null>;
  write: (p: Uint8Array) => Promise<number>;
  close: () => void;
};

export async function http1Wire(
  conn: WireConn,
  opts: Http1WireOpts,
): Promise<Http1Response> {
  let head = opts.method + ' ' + opts.path + ' HTTP/1.1\r\n' +
    'Host: ' + opts.hostHeader + '\r\n';
  for (const [name, value] of Object.entries(opts.headers)) {
    head += name + ': ' + value + '\r\n';
  }
  if (opts.body !== null) {
    head += 'Content-Length: ' + String(opts.body.length) + '\r\n';
  }
  head += 'Connection: close\r\n\r\n';
  await writeAll(conn, new TextEncoder().encode(head));
  if (opts.body !== null) await writeAll(conn, opts.body);
  return await readHttp(conn, opts);
}

async function writeAll(conn: WireConn, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const written = await conn.write(bytes.subarray(offset));
    if (written <= 0 || written > bytes.length - offset) {
      throw new MatrixError(
        502,
        'M_UNKNOWN',
        'upstream write made no progress',
      );
    }
    offset += written;
  }
}

function connectHost(ip: string): string {
  if (ip.includes(':') && !ip.startsWith('[')) return '[' + ip + ']';
  return ip;
}

async function readHttp(
  conn: WireConn,
  opts: Http1WireOpts,
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
  const sm = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(statusLine);
  if (sm === null) {
    throw new MatrixError(502, 'M_UNKNOWN', 'bad upstream status line');
  }
  const status = Number(sm[1]);
  const headers = new Headers();
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon <= 0 || /^[ \t]/.test(lines[i])) {
      throw new MatrixError(502, 'M_UNKNOWN', 'bad upstream header');
    }
    headers.append(
      lines[i].slice(0, colon).trim(),
      lines[i].slice(colon + 1).trim(),
    );
  }
  const clRaw = headers.get('content-length');
  const te = headers.get('transfer-encoding');
  if (te !== null && (clRaw !== null || te.toLowerCase() !== 'chunked')) {
    throw new MatrixError(502, 'M_UNKNOWN', 'ambiguous upstream framing');
  }
  let length: number | null = null;
  if (clRaw !== null) {
    length = Number(clRaw);
    if (!/^\d+$/.test(clRaw) || !Number.isSafeInteger(length)) {
      throw new MatrixError(502, 'M_UNKNOWN', 'bad content-length');
    }
    if (length > opts.maxBytes) {
      throw new MatrixError(502, 'M_TOO_LARGE', 'Content is too large');
    }
  }
  if (opts.method === 'HEAD' || status === 204 || status === 304) {
    return { status, headers, body: new Uint8Array() };
  }
  const stream = opts.sink === undefined ? null : opts.sink(status, headers);
  const writer = stream === null ? null : stream.getWriter();
  const parts: Uint8Array[] = [];
  let total = 0;
  const emit = async (bytes: Uint8Array) => {
    total += bytes.length;
    if (total > opts.maxBytes) {
      throw new MatrixError(502, 'M_TOO_LARGE', 'Content is too large');
    }
    if (writer === null) parts.push(bytes.slice());
    else await abortable(opts.signal, () => writer.write(bytes));
  };
  // Fixed-size reads and an awaited sink keep payload memory independent of
  // Content-Length/chunk sizes. Only the explicit buffered API retains bytes.
  let pending = leftover;
  const read = async () => {
    opts.signal?.throwIfAborted();
    const bytes = new Uint8Array(16 * 1024);
    const got = await conn.read(bytes);
    return got === null ? null : bytes.subarray(0, got);
  };
  const requireData = async () => {
    if (pending.length === 0) {
      const bytes = await read();
      if (bytes === null) {
        throw new MatrixError(502, 'M_UNKNOWN', 'upstream body truncated');
      }
      pending = bytes;
    }
  };
  let framing = 0;
  const takeLine = async (): Promise<string> => {
    for (;;) {
      const text = new TextDecoder('latin1').decode(pending);
      const idx = text.indexOf('\r\n');
      if (idx >= 0) {
        framing += idx + 2;
        if (framing > HEADER_CAP) {
          throw new MatrixError(502, 'M_UNKNOWN', 'chunk framing too large');
        }
        const line = text.slice(0, idx);
        pending = pending.subarray(idx + 2);
        return line;
      }
      const bytes = await read();
      if (bytes === null) {
        throw new MatrixError(502, 'M_UNKNOWN', 'truncated chunked body');
      }
      const next = new Uint8Array(pending.length + bytes.length);
      next.set(pending);
      next.set(bytes, pending.length);
      pending = next;
      if (pending.length > HEADER_CAP) {
        throw new MatrixError(502, 'M_UNKNOWN', 'chunk size line too long');
      }
    }
  };
  const take = async (length: number) => {
    let remaining = length;
    while (remaining > 0) {
      await requireData();
      const n = Math.min(remaining, pending.length);
      await emit(pending.subarray(0, n));
      pending = pending.subarray(n);
      remaining -= n;
    }
  };
  try {
    if (te !== null) {
      for (;;) {
        const line = await takeLine();
        const digits = line.split(';', 1)[0];
        const size = Number.parseInt(digits, 16);
        if (!/^[0-9a-fA-F]+$/.test(digits) || !Number.isSafeInteger(size)) {
          throw new MatrixError(502, 'M_UNKNOWN', 'bad chunk size');
        }
        if (size === 0) {
          for (;;) {
            const trailer = await takeLine();
            if (trailer === '') break;
            if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:/.test(trailer)) {
              throw new MatrixError(502, 'M_UNKNOWN', 'bad upstream trailer');
            }
          }
          break;
        }
        if (size > opts.maxBytes - total) {
          throw new MatrixError(502, 'M_TOO_LARGE', 'Content is too large');
        }
        await take(size);
        // Chunk data MUST end with CRLF, even across two socket reads.
        for (const expected of [13, 10]) {
          await requireData();
          if (pending[0] !== expected) {
            throw new MatrixError(502, 'M_UNKNOWN', 'bad chunk delimiter');
          }
          pending = pending.subarray(1);
        }
        framing += 2;
      }
    } else if (length !== null) {
      await take(length);
    } else {
      if (pending.length > 0) await emit(pending);
      for (;;) {
        const bytes = await read();
        if (bytes === null) break;
        await emit(bytes);
      }
    }
    if (writer !== null) await abortable(opts.signal, () => writer.close());
  } catch (error) {
    if (writer !== null) {
      // Abort may queue behind a blocked sink write. It must not extend the
      // request deadline; no subsequent network reads or writes are scheduled.
      void writer.abort(error).catch(() => undefined);
    }
    throw error;
  } finally {
    writer?.releaseLock();
  }
  const body = new Uint8Array(writer === null ? total : 0);
  let off = 0;
  for (const p of parts) {
    body.set(p, off);
    off += p.length;
  }
  return { status, headers, body };
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
    let stream: WireConn = tcp;
    if (req.tls !== null) {
      const tls = await Deno.startTls(tcp, {
        hostname: req.tls.sni !== null ? req.tls.sni : req.connectIp,
        caCerts: req.tls.caCerts,
      });
      conn = tls;
      await tls.handshake();
      stream = tls;
    }
    return await http1Wire(stream, {
      method: req.method,
      path: req.path,
      hostHeader: req.hostHeader,
      headers: req.headers,
      body: req.body,
      maxBytes: req.maxBytes,
    });
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
