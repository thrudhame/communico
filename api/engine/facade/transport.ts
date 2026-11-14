// Dedicated link TLS, not Matrix TLS or bearer authentication. The client pin
// check runs inside TLS verification, before HTTPS can send application bytes.
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { createServer, request as httpsRequest } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Duplex, Readable } from 'node:stream';
import { checkServerIdentity, type TLSSocket } from 'node:tls';
import { certificatePin, readProtectedFile } from './identity.ts';
import { LinkError } from './protocol.ts';

export type LinkTls = { cert: string; key: string; ca: string[] };
export const LINK_PREFIX = '/_communico/link/v1/';

export async function loadLinkTls(files: {
  linkcert: string;
  linkkey: string;
  linkcacerts: string[];
}): Promise<LinkTls> {
  return {
    cert: await Deno.readTextFile(files.linkcert),
    key: await readProtectedFile(files.linkkey),
    ca: await Promise.all(
      files.linkcacerts.map((path) => Deno.readTextFile(path)),
    ),
  };
}

function samePin(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function headersOf(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (let i = 0; i < message.rawHeaders.length; i += 2) {
    headers.append(message.rawHeaders[i], message.rawHeaders[i + 1]);
  }
  return headers;
}

async function writeResponse(
  target: ServerResponse,
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  target.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) {
    const reader = response.body.getReader();
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) abort();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) break;
        if (!target.write(value)) await once(target, 'drain');
      }
    } finally {
      signal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  }
  target.end();
}

export async function startLinkTransport(options: {
  hostname: string;
  port: number;
  tls: LinkTls;
  authorize(pin: string): Promise<boolean>;
  handle(request: Request, peerPin: string): Promise<Response>;
}): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<Duplex>();
  const active = new Set<Promise<void>>();
  const aborts = new Set<AbortController>();
  let closing = false;
  const server = createServer({
    ...options.tls,
    requestCert: true,
    rejectUnauthorized: true,
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  // Failed TLS handshakes are not application errors or logged credentials.
  server.on('tlsClientError', () => {});
  server.on('request', (incoming, outgoing) => {
    const controller = new AbortController();
    aborts.add(controller);
    const abort = () => controller.abort();
    const interrupt = () => {
      if (!incoming.complete) incoming.destroy();
    };
    controller.signal.addEventListener('abort', interrupt, { once: true });
    outgoing.once('close', abort);
    const work = (async () => {
      try {
        const socket = incoming.socket as TLSSocket;
        const raw = socket.getPeerCertificate()?.raw;
        const pin = raw && socket.authorized ? certificatePin(raw) : '';
        // Fresh admission per request, before reading the body. Do not cache a
        // pending/enrolled/revoked authority decision on a keep-alive socket.
        if (closing || !pin || !await options.authorize(pin)) {
          outgoing.writeHead(403, { connection: 'close' });
          outgoing.end('{"code":"LINK_IDENTITY_MISMATCH"}');
          return;
        }
        const target = new URL(incoming.url ?? '/', 'https://link.invalid');
        if (!target.pathname.startsWith(LINK_PREFIX)) {
          outgoing.writeHead(404, { connection: 'close' }).end();
          return;
        }
        controller.signal.throwIfAborted();
        const chunks: Uint8Array[] = [];
        for await (const chunk of incoming) chunks.push(chunk);
        const method = incoming.method ?? 'GET';
        const request = new Request(target, {
          method,
          headers: headersOf(incoming),
          signal: controller.signal,
          body: method === 'GET' || method === 'HEAD'
            ? undefined
            : Buffer.concat(chunks),
        });
        await writeResponse(
          outgoing,
          await options.handle(request, pin),
          controller.signal,
        );
      } catch (error) {
        if (outgoing.headersSent) outgoing.destroy();
        else {
          outgoing.writeHead(error instanceof LinkError ? error.status : 500, {
            'content-type': 'application/json',
            connection: 'close',
          }).end(
            JSON.stringify({
              code: error instanceof LinkError
                ? error.code
                : 'LINK_INTERNAL_ERROR',
            }),
          );
        }
      } finally {
        outgoing.removeListener('close', abort);
        controller.signal.removeEventListener('abort', interrupt);
        aborts.delete(controller);
      }
    })();
    active.add(work);
    void work.finally(() => active.delete(work));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.hostname, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('link listener not bound');
  }
  const host = options.hostname.includes(':')
    ? `[${options.hostname}]`
    : options.hostname;
  let closed: Promise<void> | undefined;
  return {
    url: `https://${host}:${address.port}`,
    close() {
      return closed ??= (async () => {
        closing = true;
        const stopped = new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
        server.closeIdleConnections();
        for (const controller of aborts) controller.abort();
        // Domain handlers finish before callers may close their owned store.
        await Promise.all(active);
        for (const socket of sockets) socket.destroy();
        await stopped;
      })();
    },
  };
}

export class LinkClient {
  private readonly origin: URL;
  constructor(
    private readonly tls: LinkTls,
    private readonly peer: { url: string; pin: string },
  ) {
    this.origin = new URL(peer.url);
    if (
      this.origin.protocol !== 'https:' || this.origin.username ||
      this.origin.password ||
      this.origin.pathname !== '/' || this.origin.search || this.origin.hash ||
      !/^[a-f0-9]{64}$/.test(peer.pin)
    ) {
      throw new LinkError('LINK_IDENTITY_MISMATCH', 'invalid link peer', 403);
    }
  }

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = new URL(path, this.origin);
    if (
      !path.startsWith(LINK_PREFIX) || url.origin !== this.origin.origin ||
      !url.pathname.startsWith(LINK_PREFIX) || url.hash
    ) {
      throw new LinkError('LINK_BAD_RECORD', 'invalid link path', 400);
    }
    const input = new Request(url, init);
    input.signal.throwIfAborted();
    const body = input.body
      ? Buffer.from(await input.arrayBuffer())
      : undefined;
    input.signal.throwIfAborted();
    return await new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(url, {
        ...this.tls,
        agent: false,
        rejectUnauthorized: true,
        method: input.method,
        headers: Object.fromEntries(input.headers),
        signal: input.signal,
        checkServerIdentity: (hostname, cert) => {
          const error = checkServerIdentity(hostname, cert);
          if (error) return error;
          if (!cert.raw || !samePin(certificatePin(cert.raw), this.peer.pin)) {
            return new LinkError(
              'LINK_IDENTITY_MISMATCH',
              'facade TLS pin mismatch',
              403,
            );
          }
        },
      }, (res) => {
        const status = res.statusCode ?? 500;
        const empty = input.method === 'HEAD' || status === 204 ||
          status === 205 || status === 304;
        if (empty) res.resume();
        resolve(
          new Response(
            empty ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>,
            {
              status,
              headers: headersOf(res),
            },
          ),
        );
      });
      req.once('error', reject);
      req.end(body);
    });
  }
}
