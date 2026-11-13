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
import { abortable } from '#engine/net/abort.ts';
import { networkOperation, UpstreamError } from '#engine/net/upstream-error.ts';
import {
  type Http1Response,
  http1Wire,
  type Http1WireOpts,
  type WireConn,
} from '#engine/net/http1.ts';

export type DialOpts = {
  connectIp: string;
  port: number;
  alternatives?:
    | Iterable<{ connectIp: string; port: number }>
    | AsyncIterable<{ connectIp: string; port: number }>;
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
  sink?: Http1WireOpts['sink'];
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
      sock.pause();
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
    sock.pause();
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
        this.#sock.resume();
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

// Configured PEM arrays are snapshots owned by resolve.ts. Its reset replaces
// their identity; a WeakMap neither retains old configurations nor alters trust.
const rootSnapshots = new WeakMap<string[], string[]>();
function caRoots(configured: string[]): string[] {
  let roots = rootSnapshots.get(configured);
  if (roots === undefined) {
    roots = [
      ...new Set([
        ...tls.getCACertificates('default'),
        ...tls.getCACertificates('system'),
        ...configured,
      ]),
    ];
    rootSnapshots.set(configured, roots);
  }
  return roots;
}

function connectWithDeadline(opts: {
  connectIp: string;
  port: number;
  sni: string | null;
  connectMs: number;
  signal: AbortSignal;
  trust: { rejectUnauthorized: boolean; ca?: string[] };
}): Promise<tls.TLSSocket> {
  opts.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const sock = tls.connect({
      host: opts.connectIp,
      port: opts.port,
      servername: opts.sni !== null ? opts.sni : undefined,
      ...opts.trust,
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
      reject(
        new UpstreamError('transport', {
          phase: 'connect',
          reason: 'upstream connect timeout',
        }),
      );
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

function verifyIdentity(sock: tls.TLSSocket, trust: DialOpts['trust']): void {
  if (trust.kind === 'ca') return; // Chain and name were verified in the handshake.
  const cert = sock.getPeerCertificate();
  const raw = cert !== null && typeof cert === 'object'
    ? (cert as { raw?: Buffer }).raw
    : undefined;
  if (raw === undefined || raw.length === 0) {
    throw new UpstreamError('validation', {
      phase: 'tls-identity',
      reason: 'peer presented no certificate',
    });
  }
  if (trust.kind === 'pinned') {
    if (spkiSha256(new Uint8Array(raw)) !== trust.spkiSha256) {
      throw new UpstreamError('validation', {
        phase: 'tls-identity',
        reason: 'peer certificate does not match the roster pin',
      });
    }
    return;
  }
  const x = new X509Certificate(raw);
  const spki = x.publicKey.export({ type: 'spki', format: 'der' });
  const prefix = new Uint8Array([
    0x30,
    0x2a,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x70,
    0x03,
    0x21,
    0x00,
  ]);
  const ed25519 = x.publicKey.asymmetricKeyType === 'ed25519' &&
    spki.length === 44 && prefix.every((b, i) => spki[i] === b);
  const rawKey = new Uint8Array(spki.subarray(prefix.length));
  const matches = ed25519 && rawKey.length === trust.pubkey.length &&
    rawKey.every((b, i) => b === trust.pubkey[i]);
  if (!matches) {
    throw new UpstreamError('validation', {
      phase: 'tls-identity',
      reason: 'peer certificate does not match the key-is-name key',
    });
  }
}

export async function dialNodeTls(opts: DialOpts): Promise<Http1Response> {
  opts.signal?.throwIfAborted();
  // Local trust preparation is outside networkOperation's peer classification.
  // Explicit CA roots extend bundled/system trust; pin/keyname identity is
  // checked separately before any HTTP bytes leave the verified connection.
  const trust = opts.trust.kind === 'ca'
    ? { rejectUnauthorized: true, ca: caRoots(opts.trust.caCerts) }
    : { rejectUnauthorized: false };
  let conn: NodeTlsConn | null = null;
  const ac = new AbortController();
  const cancel = () => {
    ac.abort(
      opts.signal?.aborted
        ? opts.signal.reason
        : new UpstreamError('transport', {
          phase: 'deadline',
          reason: 'upstream timeout',
        }),
    );
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
    let sock: tls.TLSSocket | null = null;
    let failure: unknown;
    const addresses = async function* () {
      yield { connectIp: opts.connectIp, port: opts.port };
      if (opts.alternatives !== undefined) {
        const rest = (async function* () {
          yield* opts.alternatives!;
        })();
        for (;;) {
          const next = await abortable(ac.signal, () => rest.next());
          if (next.done) break;
          yield next.value;
        }
      }
    };
    // Alternate addresses are eligible ONLY until a verified connection is
    // selected. HTTP writes/reads, decoding and sinks are deliberately outside
    // this loop: an uncertain or consuming request can never be replayed here.
    for await (const address of addresses()) {
      ac.signal.throwIfAborted();
      try {
        sock = await networkOperation(
          'tls',
          ac.signal,
          () =>
            connectWithDeadline({
              ...address,
              sni: opts.sni,
              connectMs: opts.connectMs,
              signal: ac.signal,
              trust,
            }),
        );
        verifyIdentity(sock, opts.trust);
        break;
      } catch (error) {
        sock?.destroy();
        sock = null;
        ac.signal.throwIfAborted();
        if (
          !(error instanceof UpstreamError) ||
          !['transport', 'validation'].includes(error.category)
        ) throw error;
        failure = error;
      }
    }
    if (sock === null) throw failure;
    conn = new NodeTlsConn(sock);
    opts.signal?.throwIfAborted();
    ac.signal.throwIfAborted();
    const connected = conn;
    const network: WireConn = {
      read: (p) => networkOperation('read', ac.signal, () => connected.read(p)),
      write: (p) =>
        networkOperation('write', ac.signal, () => connected.write(p)),
      close: () => connected.close(),
    };
    return await http1Wire(network, {
      method: opts.method,
      path: opts.path,
      hostHeader: opts.hostHeader,
      headers: opts.headers,
      body: opts.body,
      maxBytes: opts.maxBytes,
      sink: opts.sink,
      signal: ac.signal,
    });
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
