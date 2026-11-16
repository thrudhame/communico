// Own TLS from socket creation through final close, independently of the
// caller's injected trust policy and TCP-only or handshake-inclusive budget.
import tls from 'node:tls';
import { Buffer } from 'node:buffer';
import type { WireConn } from './http1.ts';
import { UpstreamError } from './upstream-error.ts';

export type TlsConnectionOptions = {
  connectIp: string;
  port: number;
  sni: string | null;
  signal: AbortSignal;
  connectMs: number;
  connectUntil: 'connect' | 'secureConnect';
  connectPhase: 'connect' | 'tls';
  connectError: () => unknown;
  trust: { rejectUnauthorized: boolean; ca?: string[] };
};

export class TlsConnection implements WireConn {
  readonly ready: Promise<void>;
  #socket: tls.TLSSocket;
  #queue: Uint8Array[] = [];
  #waiter: (() => void) | null = null;
  #ended = false;
  #error: unknown = null;
  #cleanup: () => void;

  constructor(opts: TlsConnectionOptions) {
    opts.signal.throwIfAborted();
    this.#socket = tls.connect({
      host: opts.connectIp,
      port: opts.port,
      servername: opts.sni === null ? undefined : opts.sni,
      ...opts.trust,
    });
    const socket = this.#socket;
    let tcpConnected = false;
    const handshakeFailure = (cause: unknown) =>
      new UpstreamError('transport', {
        phase: tcpConnected ? 'tls' : opts.connectPhase,
        reason: 'connection failed',
        cause,
      });
    socket.once('connect', () => tcpConnected = true);
    let rejectReady!: (reason: unknown) => void;
    let resolveReady!: () => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const cancel = () => {
      rejectReady(opts.signal.reason);
      this.close();
    };
    this.#cleanup = () => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', cancel);
    };
    opts.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      rejectReady(opts.connectError());
      this.close();
    }, opts.connectMs);
    socket.once(opts.connectUntil, () => clearTimeout(timer));
    socket.once('secureConnect', () => {
      try {
        opts.signal.throwIfAborted();
        resolveReady();
      } catch (error) {
        rejectReady(error);
        this.close();
      }
    });
    socket.on('data', (data: Buffer) => {
      socket.pause();
      this.#queue.push(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
      this.#poke();
    });
    socket.on('end', () => {
      this.#ended = true;
      this.#poke();
    });
    socket.on('close', () => {
      this.#cleanup();
      rejectReady(
        handshakeFailure(
          new Error('TLS connection closed before handshake completed'),
        ),
      );
      this.#ended = true;
      this.#poke();
    });
    socket.on('error', (error: unknown) => {
      this.#error = error;
      rejectReady(handshakeFailure(error));
      this.close();
      this.#poke();
    });
    socket.pause();
  }

  #poke(): void {
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.();
  }

  async read(buffer: Uint8Array): Promise<number | null> {
    while (this.#queue.length === 0) {
      if (this.#error !== null) throw this.#error;
      if (this.#ended) return null;
      await new Promise<void>((resolve) => {
        this.#waiter = resolve;
        this.#socket.resume();
      });
    }
    const head = this.#queue[0];
    const count = Math.min(buffer.length, head.length);
    buffer.set(head.subarray(0, count));
    this.#queue[0] = head.subarray(count);
    if (this.#queue[0].length === 0) this.#queue.shift();
    return count;
  }

  peerCertificate(): ReturnType<tls.TLSSocket['getPeerCertificate']> {
    return this.#socket.getPeerCertificate();
  }

  write(buffer: Uint8Array): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#socket.write(
        Buffer.from(buffer),
        (error?: Error | null) =>
          error ? reject(error) : resolve(buffer.length),
      );
    });
  }

  close(): void {
    this.#cleanup();
    this.#socket.destroy();
  }
}
