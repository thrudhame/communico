// api/engine/federation/dial-node-tls.ts — pinned and key-is-name dialing
// over node:tls (the M5a §3.8 spike passed on the VM's Deno 2.9.6). This
// module is the ONLY place in the tree with `rejectUnauthorized: false` —
// grep-enforced; the process-wide flag is never used. The peer
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
    | { kind: 'pinned'; spkiSha256: string }
    | { kind: 'keyname'; pubkey: Uint8Array };
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  connectMs: number;
  timeoutMs: number;
  maxBytes: number;
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
}): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    // rejectUnauthorized: false — identity is checked below against the
    // roster's pin/key; nowhere else in the tree does this
    const sock = tls.connect({
      host: opts.connectIp,
      port: opts.port,
      servername: opts.sni !== null ? opts.sni : undefined,
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`connect timeout after ${opts.connectMs}ms`));
    }, opts.connectMs);
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (e: Error) => {
      clearTimeout(timer);
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
  const deadline = Date.now() + opts.timeoutMs;
  let conn: NodeTlsConn | null = null;
  const totalTimer = setTimeout(
    () => {
      try {
        if (conn !== null) conn.close();
      } catch { /* already closed */ }
    },
    opts.timeoutMs,
  );
  try {
    const sock = await connectWithDeadline({
      connectIp: opts.connectIp,
      port: opts.port,
      sni: opts.sni,
      connectMs: opts.connectMs,
    });
    conn = new NodeTlsConn(sock);
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
    } else {
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
