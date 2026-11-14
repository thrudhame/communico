// Dedicated link TLS, not Matrix TLS or bearer authentication. The client pin
// check runs inside TLS verification, before HTTPS can send application bytes.
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { createServer, request as httpsRequest } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Duplex, Readable } from 'node:stream';
import { checkServerIdentity, type TLSSocket } from 'node:tls';
// @deno-types="npm:@types/ws@8.18.2"
import WebSocket, { WebSocketServer } from 'ws';
import { certificatePin, readProtectedFile } from './identity.ts';
import { LinkError } from './protocol.ts';
import { lines } from './notices.ts';

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
  const upgrades = new WebSocketServer({ noServer: true, maxPayload: 0 });
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
  server.on('upgrade', (incoming, socket, head) => {
    socket.on('error', () => {});
    const controller = new AbortController();
    aborts.add(controller);
    const abort = () => controller.abort();
    socket.once('close', abort);
    const work = (async () => {
      let response: Response | undefined;
      let ws: WebSocket | undefined;
      const interrupt = () => ws ? ws.terminate() : socket.destroy();
      controller.signal.addEventListener('abort', interrupt, { once: true });
      try {
        const tls = incoming.socket as TLSSocket;
        const raw = tls.getPeerCertificate()?.raw;
        const pin = raw && tls.authorized ? certificatePin(raw) : '';
        if (closing || !pin || !await options.authorize(pin)) {
          throw new LinkError(
            'LINK_IDENTITY_MISMATCH',
            'home TLS pin mismatch',
            403,
          );
        }
        const url = new URL(incoming.url ?? '/', 'https://link.invalid');
        if (
          incoming.method !== 'GET' || url.pathname !== LINK_PREFIX + 'notices'
        ) {
          throw new LinkError('LINK_BAD_RECORD', 'not a notice endpoint', 404);
        }
        controller.signal.throwIfAborted();
        response = await options.handle(
          new Request(url, {
            headers: headersOf(incoming),
            signal: controller.signal,
          }),
          pin,
        );
        if (!response.ok) {
          socket.end(
            `HTTP/1.1 ${response.status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          );
          return;
        }
        if (
          !response.body ||
          response.headers.get('content-type') !== 'application/x-ndjson'
        ) {
          throw new LinkError('LINK_BAD_RECORD', 'not a notice stream', 400);
        }
        controller.signal.throwIfAborted();
        // Domain authentication is complete before the library sends HTTP 101
        // or processes any buffered application frames in head.
        upgrades.handleUpgrade(incoming, socket, head, (upgraded) => {
          ws = upgraded;
          ws.on('error', abort);
          ws.on('close', abort);
          // The home never sends application messages on this channel.
          ws.on('message', () => ws!.terminate());
        });
        if (!ws) return;
        for await (const line of lines(response.body)) {
          if (controller.signal.aborted) break;
          await new Promise<void>((resolve, reject) => {
            ws!.send(
              line,
              { binary: false },
              (error) => error ? reject(error) : resolve(),
            );
          });
        }
      } catch (error) {
        if (!ws && !socket.destroyed) {
          const status = error instanceof LinkError ? error.status : 500;
          socket.end(
            `HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          );
        }
      } finally {
        await response?.body?.cancel().catch(() => {});
        ws?.terminate();
        controller.abort();
        socket.removeListener('close', abort);
        controller.signal.removeEventListener('abort', interrupt);
        aborts.delete(controller);
      }
    })();
    active.add(work);
    void work.finally(() => active.delete(work));
  });
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
        await new Promise<void>((resolve) => upgrades.close(() => resolve()));
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

  private target(path: string): URL {
    const url = new URL(path, this.origin);
    if (
      !path.startsWith(LINK_PREFIX) || url.origin !== this.origin.origin ||
      !url.pathname.startsWith(LINK_PREFIX) || url.hash
    ) {
      throw new LinkError('LINK_BAD_RECORD', 'invalid link path', 400);
    }
    return url;
  }

  private tlsOptions() {
    return {
      ...this.tls,
      agent: false as const,
      rejectUnauthorized: true,
      checkServerIdentity: (
        hostname: string,
        cert: import('node:tls').PeerCertificate,
      ) => {
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
    };
  }

  async websocket(
    path: string,
    init: { headers: HeadersInit; signal: AbortSignal },
  ): Promise<ReadableStream<string>> {
    const url = this.target(path);
    if (url.pathname !== LINK_PREFIX + 'notices') {
      throw new LinkError('LINK_BAD_RECORD', 'not a notice endpoint', 400);
    }
    init.signal.throwIfAborted();
    return await new Promise<ReadableStream<string>>((resolve, reject) => {
      const ws = new WebSocket(url, {
        ...this.tlsOptions(),
        headers: Object.fromEntries(new Headers(init.headers)),
        perMessageDeflate: false,
        maxPayload: 0,
      });
      let ended = false;
      let opened = false;
      let controller: ReadableStreamDefaultController<string>;
      const body = new ReadableStream<string>({
        start(value) {
          controller = value;
        },
        pull() {
          ws.resume();
        },
        cancel() {
          ended = true;
          ws.terminate();
        },
      });
      const stop = () => {
        if (!ended) {
          ended = true;
          controller.error(init.signal.reason);
        }
        reject(init.signal.reason);
        ws.terminate();
      };
      init.signal.addEventListener('abort', stop, { once: true });
      ws.on('open', () => {
        opened = true;
        resolve(body);
      });
      ws.on('message', (data, binary) => {
        if (ended) return;
        if (binary) {
          ended = true;
          controller.error(
            new LinkError('LINK_BAD_RECORD', 'binary notice', 400),
          );
          ws.terminate();
        } else {
          controller.enqueue(data.toString());
          if ((controller.desiredSize ?? 0) <= 0) ws.pause();
        }
      });
      ws.on('error', (error) => {
        if (!ended) {
          ended = true;
          controller.error(error);
        }
        reject(error);
      });
      ws.on('close', () => {
        init.signal.removeEventListener('abort', stop);
        if (!ended) {
          ended = true;
          controller.close();
        }
        if (!opened) {
          reject(
            new LinkError('LINK_UNAVAILABLE', 'notice connection closed', 503),
          );
        }
      });
      if (init.signal.aborted) stop();
    });
  }

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = this.target(path);
    const input = new Request(url, init);
    input.signal.throwIfAborted();
    const body = input.body
      ? Buffer.from(await input.arrayBuffer())
      : undefined;
    input.signal.throwIfAborted();
    return await new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(url, {
        ...this.tlsOptions(),
        method: input.method,
        headers: Object.fromEntries(input.headers),
        signal: input.signal,
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
