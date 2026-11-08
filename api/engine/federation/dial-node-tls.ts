// One outbound TLS transport for federation requests and discovery. CA trust
// verifies the certificate chain and resolved server identity against system,
// bundled and configured roots. Pin/keyname trust checks the peer key instead;
// only this module may disable certificate-chain verification. The peer
// certificate's SPKI SHA-256 is computed via node:crypto X509Certificate
// (Deno's getPeerCertificate().pubkey is undefined for Ed25519 — only
// RSA/EC); pinned peers match SPKI equality, key-is-name peers match the
// raw 32-byte key equality. A mismatch destroys the socket before ANY
// request bytes are written (spike criterion (f)) and yields a 502. The
// socket is wrapped in the read/write/close adapter the http1Wire helper
// uses; connect and total timeouts are the federation leaves' budgets.
// sock.getSession() resumption does NOT remove the peer cert (criterion
// (f)) — no ticket suppression needed.
import tls from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  type Http1Response,
  http1Wire,
  type WireConn,
} from '#engine/net/http1.ts';

export type DialOpts = {
  connectIp: string;
  port: number;
  sni: string | null;
  hostHeader: string;
  trust:
    | { kind: 'ca'; caCerts: string[] }
    | { kind: 'pinned'; spkiSha256: string }
    | { kind: 'keyname'; pubkey: Uint8Array };
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  connectMs: number;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
};

// node:tls TLSSocket → the WireConn shape
class NodeTlsConn {
  #sock: tls.TLSSocket;
  #queue: Uint8Array[] = [];
  #waiter: (() => void) | null = null;
  #ended = false;
  #err: unknown = null;

  constructor(sock: tls.TLSSocket) {
    this.#sock = sock;
    sock.on('data', (d: Buffer) => {
      this.#queue.push(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
      this.#poke();
    });
    sock.on('end', () => {
      this.#ended = true;
      this.#poke();
    });
    sock.on('close', () => {
      this.#ended = true;
      this.#poke();
    });
    sock.on('error', (e: unknown) => {
      this.#err = e;
      this.#ended = true;
      this.#poke();
    });
  }

  #poke(): void {
    const w = this.#waiter;
    this.#waiter = null;
    if (w !== null) w();
  }

  async read(p: Uint8Array): Promise<number | null> {
    while (this.#queue.length === 0) {
      if (this.#err !== null) throw this.#err;
      if (this.#ended) return null;
      await new Promise<void>((r) => {
        this.#waiter = r;
      });
    }
    const head = this.#queue[0];
    const n = Math.min(p.length, head.length);
    p.set(head.subarray(0, n));
    this.#queue[0] = head.subarray(n);
    if (this.#queue[0].length === 0) this.#queue.shift();
    return n;
  }

  write(p: Uint8Array): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#sock.write(
        Buffer.from(p),
        (e?: Error | null) => e ? reject(e) : resolve(p.length),
      );
    });
  }

  close(): void {
    this.#sock.destroy();
  }
}

function connectWithDeadline(opts: {
  connectIp: string;
  port: number;
  sni: string | null;
  connectMs: number;
  signal: AbortSignal;
  trust: DialOpts['trust'];
}): Promise<tls.TLSSocket> {
  opts.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Explicit CA roots extend normal bundled/system trust; they never replace it.
    const trust = opts.trust.kind === 'ca'
      ? {
        rejectUnauthorized: true,
        ca: [
          ...new Set([
            ...tls.getCACertificates('default'),
            ...tls.getCACertificates('system'),
            ...opts.trust.caCerts,
          ]),
        ],
      }
      : { rejectUnauthorized: false }; // Identity is checked below against the roster pin/key.
    const sock = tls.connect({
      host: opts.connectIp,
      port: opts.port,
      servername: opts.sni !== null ? opts.sni : undefined,
      ...trust,
    });
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      cleanup();
      sock.destroy();
      reject(opts.signal.reason);
    };
    opts.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      cleanup();
      sock.destroy();
      reject(new Error(`connect timeout after ${opts.connectMs}ms`));
    }, opts.connectMs);
    sock.once('secureConnect', () => {
      cleanup();
      resolve(sock);
    });
    sock.once('error', (e: Error) => {
      cleanup();
      reject(e);
    });
  });
}

function spkiSha256(raw: Uint8Array): string {
  const x = new X509Certificate(raw);
  const spki = x.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex');
}

export async function dialNodeTls(opts: DialOpts): Promise<Http1Response> {
  opts.signal?.throwIfAborted();
  const deadline = Date.now() + opts.timeoutMs;
  let conn: NodeTlsConn | null = null;
  const ac = new AbortController();
  const cancel = () => {
    ac.abort();
    try {
      if (conn !== null) conn.close();
    } catch { /* already closed */ }
  };
  opts.signal?.addEventListener('abort', cancel, { once: true });
  const totalTimer = setTimeout(
    cancel,
    opts.timeoutMs,
  );
  try {
    const sock = await connectWithDeadline({
      connectIp: opts.connectIp,
      port: opts.port,
      sni: opts.sni,
      connectMs: opts.connectMs,
      signal: ac.signal,
      trust: opts.trust,
    });
    conn = new NodeTlsConn(sock);
    opts.signal?.throwIfAborted();
    ac.signal.throwIfAborted();
    // identity check BEFORE any request bytes are written
    const cert = sock.getPeerCertificate(true);
    const raw = cert !== null && typeof cert === 'object'
      ? (cert as { raw?: Buffer }).raw
      : undefined;
    if (raw === undefined || raw.length === 0) {
      conn.close();
      throw new MatrixError(
        502,
        'M_UNKNOWN',
        'peer presented no certificate',
      );
    }
    if (opts.trust.kind === 'pinned') {
      const got = spkiSha256(new Uint8Array(raw));
      if (got !== opts.trust.spkiSha256) {
        conn.close();
        throw new MatrixError(
          502,
          'M_UNKNOWN',
          'peer certificate does not match the roster pin',
        );
      }
    } else if (opts.trust.kind === 'keyname') {
      const x = new X509Certificate(raw);
      const spki = x.publicKey.export({ type: 'spki', format: 'der' });
      const rawKey = new Uint8Array(spki.subarray(12));
      const expected = opts.trust.pubkey;
      const matches = rawKey.length === expected.length &&
        rawKey.every((b, i) => b === expected[i]);
      if (!matches) {
        conn.close();
        throw new MatrixError(
          502,
          'M_UNKNOWN',
          'peer certificate does not match the key-is-name key',
        );
      }
    }
    return await http1Wire(conn as WireConn, {
      method: opts.method,
      path: opts.path,
      hostHeader: opts.hostHeader,
      headers: opts.headers,
      body: opts.body,
      maxBytes: opts.maxBytes,
    });
  } catch (e) {
    opts.signal?.throwIfAborted();
    if (e instanceof MatrixError) throw e;
    if (Date.now() >= deadline) {
      throw new MatrixError(502, 'M_UNKNOWN', 'upstream timeout');
    }
    throw new MatrixError(502, 'M_UNKNOWN', 'upstream connection failed');
  } finally {
    opts.signal?.removeEventListener('abort', cancel);
    clearTimeout(totalTimer);
    if (conn !== null) {
      try {
        conn.close();
      } catch { /* already closed */ }
    }
  }
}
