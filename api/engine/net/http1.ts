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
import { abortable } from '#engine/net/abort.ts';
import { field, fieldText, trimOws } from './fields.ts';
import {
  limit,
  networkOperation,
  protocol,
  UpstreamError,
} from './upstream-error.ts';

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
  signal?: AbortSignal;
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
  if (
    !Object.keys(opts.headers).some((name) =>
      name.toLowerCase() === 'accept-encoding'
    )
  ) {
    head += 'Accept-Encoding: gzip, deflate, br\r\n';
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
      throw new UpstreamError('transport', {
        phase: 'write',
        reason: 'upstream write made no progress',
      });
    }
    offset += written;
  }
}

function connectHost(ip: string): string {
  if (ip.includes(':') && !ip.startsWith('[')) return '[' + ip + ']';
  return ip;
}

function chunkExtensions(raw: string): void {
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
  const quoted =
    '"(?:[\\t\\x20-\\x21\\x23-\\x5b\\x5d-\\x7e\\x80-\\xff]|\\\\[\\t\\x20-\\x7e\\x80-\\xff])*"';
  if (
    !new RegExp(
      '^(?:[ \\t]*;[ \\t]*' + token + '(?:[ \\t]*=[ \\t]*(?:' + token + '|' +
        quoted + '))?)*$',
    ).test(raw)
  ) {
    protocol('http-framing', 'bad chunk extension');
  }
}

async function readHttp(
  conn: WireConn,
  opts: Http1WireOpts,
): Promise<Http1Response> {
  let pending: Uint8Array = new Uint8Array();
  const read = async () => {
    opts.signal?.throwIfAborted();
    const bytes = new Uint8Array(16 * 1024);
    const got = await abortable(opts.signal, () => conn.read(bytes));
    return got === null ? null : bytes.subarray(0, got);
  };
  const append = (bytes: Uint8Array) => {
    const next = new Uint8Array(pending.length + bytes.length);
    next.set(pending);
    next.set(bytes, pending.length);
    pending = next;
  };
  let status: number;
  let headers: Headers;
  for (;;) {
    let sep: number;
    for (;;) {
      sep = fieldText(pending).indexOf('\r\n\r\n');
      if (sep >= 0) break;
      if (pending.length >= HEADER_CAP) {
        limit('http-head', 'upstream headers too large');
      }
      const bytes = await read();
      if (bytes === null) protocol('http-head', 'upstream headers truncated');
      append(bytes);
    }
    if (sep + 4 > HEADER_CAP) limit('http-head', 'upstream headers too large');
    const lines = fieldText(pending.subarray(0, sep)).split('\r\n');
    pending = pending.subarray(sep + 4);
    const match = /^HTTP\/1\.[01] ([1-5][0-9]{2}) [\t\x20-\x7e\x80-\xff]*$/
      .exec(lines[0]);
    if (match === null) protocol('http-head', 'bad upstream status line');
    status = Number(match[1]);
    headers = new Headers();
    for (const line of lines.slice(1)) {
      const [name, value] = field(line);
      headers.append(name, value);
    }
    if (status >= 200) break;
    if (status === 101) protocol('http-head', 'unsupported protocol switch');
    // Informational heads have no body. Keep already-read final-head bytes.
  }
  const clRaw = headers.get('content-length');
  const te = headers.get('transfer-encoding');
  if (te !== null && clRaw !== null) {
    protocol('http-framing', 'ambiguous upstream framing');
  }
  if (te !== null && te.toLowerCase() !== 'chunked') {
    protocol('http-framing', 'unsupported transfer-encoding');
  }
  let length: number | null = null;
  if (clRaw !== null) {
    length = Number(clRaw);
    if (!/^\d+$/.test(clRaw) || !Number.isSafeInteger(length)) {
      protocol('http-framing', 'bad content-length');
    }
  }
  if (opts.method === 'HEAD' || status === 204 || status === 304) {
    return { status, headers, body: new Uint8Array() };
  }
  if (length !== null && length > opts.maxBytes) limit('http-body');
  const encoding = headers.get('content-encoding');
  const codings = encoding === null
    ? []
    : encoding.split(',').map((c) => trimOws(c).toLowerCase());
  for (const coding of codings) {
    if (!['identity', 'gzip', 'deflate', 'br'].includes(coding)) {
      protocol('http-representation', 'unsupported content-encoding');
    }
  }
  const compressed = codings.some((c) => c !== 'identity');
  if (compressed) {
    headers.delete('content-encoding');
    headers.delete('content-length');
  }
  const stream = opts.sink === undefined ? null : opts.sink(status, headers);
  const writer = stream === null ? null : stream.getWriter();
  const parts: Uint8Array[] = [];
  let total = 0;
  let decoded = 0;
  const output = async (bytes: Uint8Array) => {
    decoded += bytes.length;
    if (decoded > opts.maxBytes) limit('http-representation');
    if (writer === null) parts.push(bytes.slice());
    else await abortable(opts.signal, () => writer.write(bytes));
  };
  let decoder: WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>> | null =
    null;
  let decoding: Promise<void> | null = null;
  if (compressed) {
    const input = new TransformStream<
      Uint8Array<ArrayBuffer>,
      Uint8Array<ArrayBuffer>
    >();
    decoder = input.writable.getWriter();
    let representation = input.readable;
    for (const coding of codings.toReversed()) {
      if (coding === 'identity') continue;
      representation = representation.pipeThrough(
        new DecompressionStream(
          coding === 'br' ? 'brotli' : coding as 'gzip' | 'deflate',
        ),
      );
      // Bound intermediate representations too, including nested compression.
      let expanded = 0;
      representation = representation.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            expanded += chunk.length;
            if (expanded > opts.maxBytes) limit('http-representation');
            controller.enqueue(chunk);
          },
        }),
      );
    }
    const reader = representation.getReader();
    decoding = (async () => {
      try {
        for (;;) {
          let next: ReadableStreamReadResult<Uint8Array>;
          try {
            next = await abortable(opts.signal, () => reader.read());
          } catch (cause) {
            opts.signal?.throwIfAborted();
            if (cause instanceof UpstreamError) throw cause;
            protocol('http-representation', 'invalid content-encoding', cause);
          }
          if (next.done) break;
          await output(next.value);
        }
      } catch (error) {
        void reader.cancel(error).catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
    })();
    void decoding.catch(() => {});
  }
  const emit = async (bytes: Uint8Array) => {
    total += bytes.length;
    if (total > opts.maxBytes) limit('http-body');
    if (decoder) {
      await abortable(opts.signal, () => decoder!.write(bytes.slice()));
    } else await output(bytes);
  };
  // Fixed-size reads and an awaited sink keep payload memory independent of
  // Content-Length/chunk sizes. Only the explicit buffered API retains bytes.
  const requireData = async () => {
    if (pending.length === 0) {
      const bytes = await read();
      if (bytes === null) {
        protocol('http-body', 'upstream body truncated');
      }
      pending = bytes;
    }
  };
  const takeLine = async (): Promise<string> => {
    for (;;) {
      const text = fieldText(pending);
      const idx = text.indexOf('\r\n');
      if (idx >= 0) {
        if (idx + 2 > HEADER_CAP) limit('http-framing', 'chunk line too large');
        const line = text.slice(0, idx);
        pending = pending.subarray(idx + 2);
        return line;
      }
      if (pending.length >= HEADER_CAP) {
        limit('http-framing', 'chunk size line too long');
      }
      const bytes = await read();
      if (bytes === null) {
        protocol('http-framing', 'truncated chunked body');
      }
      append(bytes);
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
        const match = /^[0-9a-fA-F]+/.exec(line);
        const digits = match === null ? '' : match[0];
        const size = Number.parseInt(digits, 16);
        if (!/^[0-9a-fA-F]+$/.test(digits) || !Number.isSafeInteger(size)) {
          protocol('http-framing', 'bad chunk size');
        }
        chunkExtensions(line.slice(digits.length));
        if (size === 0) {
          let trailerBytes = 0;
          for (;;) {
            const trailer = await takeLine();
            trailerBytes += trailer.length + 2;
            if (trailerBytes > HEADER_CAP) {
              limit('http-framing', 'trailers too large');
            }
            if (trailer === '') break;
            const [name] = field(trailer, 'http-trailer');
            if (
              [
                'content-length',
                'transfer-encoding',
                'content-encoding',
                'content-type',
                'host',
                'authorization',
              ].includes(name)
            ) protocol('http-trailer', 'forbidden upstream trailer');
          }
          break;
        }
        if (size > opts.maxBytes - total) {
          limit('http-body');
        }
        await take(size);
        // Chunk data MUST end with CRLF, even across two socket reads.
        for (const expected of [13, 10]) {
          await requireData();
          if (pending[0] !== expected) {
            protocol('http-framing', 'bad chunk delimiter');
          }
          pending = pending.subarray(1);
        }
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
    if (decoder !== null) await abortable(opts.signal, () => decoder!.close());
    if (decoding !== null) await decoding;
    if (writer !== null) await abortable(opts.signal, () => writer.close());
  } catch (error) {
    let failure = error;
    if (decoder !== null) void decoder.abort(error).catch(() => {});
    if (decoding !== null) {
      try {
        await decoding;
      } catch (cause) {
        // The writable side of a decompressor can reject with its native
        // TypeError before the reader's classified error reaches us. Prefer
        // that reader provenance, without replacing framing/network/abort.
        if (!(error instanceof UpstreamError) && !opts.signal?.aborted) {
          failure = cause;
        }
      }
    }
    if (writer !== null) {
      // Abort may queue behind a blocked sink write. It must not extend the
      // request deadline; no subsequent network reads or writes are scheduled.
      void writer.abort(failure).catch(() => undefined);
    }
    throw failure;
  } finally {
    writer?.releaseLock();
  }
  const body = new Uint8Array(writer === null ? decoded : 0);
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
  req.signal?.throwIfAborted();
  const ac = new AbortController();
  const timeout = () =>
    ac.abort(
      new UpstreamError('transport', {
        phase: 'deadline',
        reason: 'upstream timeout',
      }),
    );
  let conn: Deno.Conn | null = null;
  const cancel = () => {
    ac.abort(req.signal?.reason);
    try {
      if (conn !== null) conn.close();
    } catch { /* already closed */ }
  };
  req.signal?.addEventListener('abort', cancel, { once: true });
  // the whole-request budget: on fire, close the connection — a pending
  // read/handshake errors and is reported below as a timeout
  const totalTimer = setTimeout(
    () => {
      timeout();
      try {
        if (conn !== null) conn.close();
      } catch { /* already closed */ }
    },
    req.timeoutMs,
  );
  try {
    const connectTimer = setTimeout(
      timeout,
      Math.min(req.connectMs, req.timeoutMs),
    );
    let tcp: Deno.TcpConn;
    try {
      tcp = await networkOperation('connect', ac.signal, () =>
        Deno.connect({
          hostname: connectHost(req.connectIp),
          port: req.port,
          signal: ac.signal,
        }));
    } finally {
      clearTimeout(connectTimer);
    }
    conn = tcp;
    let stream: WireConn = tcp;
    if (req.tls !== null) {
      const identity = req.tls;
      const tls = await networkOperation(
        'tls',
        ac.signal,
        () =>
          Deno.startTls(tcp, {
            hostname: identity.sni !== null ? identity.sni : req.connectIp,
            caCerts: identity.caCerts,
          }),
      );
      conn = tls;
      await networkOperation('tls', ac.signal, () => tls.handshake());
      stream = tls;
    }
    const network: WireConn = {
      read: (p) => networkOperation('read', ac.signal, () => stream.read(p)),
      write: (p) => networkOperation('write', ac.signal, () => stream.write(p)),
      close: () => stream.close(),
    };
    return await http1Wire(network, {
      method: req.method,
      path: req.path,
      hostHeader: req.hostHeader,
      headers: req.headers,
      body: req.body,
      maxBytes: req.maxBytes,
      signal: ac.signal,
    });
  } finally {
    req.signal?.removeEventListener('abort', cancel);
    clearTimeout(totalTimer);
    if (conn !== null) {
      try {
        conn.close();
      } catch { /* already closed */ }
    }
  }
}
