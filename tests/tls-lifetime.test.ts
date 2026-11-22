import { assert, assertEquals, assertStrictEquals } from '@std/assert';
import tls from 'node:tls';
import net from 'node:net';
import { http1Request } from '#engine/net/http1.ts';
import { dialNodeTls } from '#engine/federation/dial-node-tls.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { TlsConnection } from '#engine/net/tls-connection.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => resolve = r);
  return { promise, resolve };
}

async function observed<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const ca = await Deno.readTextFile('tests/fixtures/tls/ca.crt');
const cert = await Deno.readTextFile('tests/fixtures/tls/localhost.crt');
const key = await Deno.readTextFile('tests/fixtures/tls/localhost.key');

for (const caller of ['http1', 'federation'] as const) {
  const request = (
    port: number,
    signal?: AbortSignal,
    sni: string | null = 'localhost',
    caCerts = [ca],
    budgets = { connectMs: 30_000, timeoutMs: 30_000 },
  ) => {
    const common = {
      connectIp: '127.0.0.1',
      port,
      hostHeader: 'localhost',
      method: 'GET',
      path: '/',
      headers: {},
      body: null,
      ...budgets,
      maxBytes: 1024,
      signal,
    };
    return caller === 'http1'
      ? http1Request({ ...common, tls: { sni, caCerts } })
      : dialNodeTls({ ...common, sni, trust: { kind: 'ca', caCerts } });
  };

  for (
    const outcome of [
      'success',
      'protocol failure',
      'abort',
      'body abort',
    ] as const
  ) {
    Deno.test(`${caller}: TLS owner releases the actual peer on ${outcome}`, async () => {
      const accepted = deferred(), closed = deferred(), requested = deferred();
      const bodyReading = deferred();
      const read = TlsConnection.prototype.read;
      let sawBody = false;
      let received = '';
      if (outcome === 'body abort') {
        TlsConnection.prototype.read = async function (buffer) {
          if (sawBody) bodyReading.resolve();
          const count = await read.call(this, buffer);
          if (count !== null) {
            received += new TextDecoder().decode(buffer.subarray(0, count));
            sawBody = received.includes('\r\n\r\no');
          }
          return count;
        };
      }
      const sockets = new Set<net.Socket>();
      const server = tls.createServer({ cert, key }, (socket) => {
        accepted.resolve();
        socket.once('data', () => {
          requested.resolve();
          if (outcome !== 'abort') {
            socket.write(
              outcome === 'body abort'
                ? 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\no'
                : outcome === 'success'
                ? 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'
                : 'HTTP/1.1 200 OK\r\nContent-Length: invalid\r\n\r\n',
            );
          }
        });
      });
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.once('close', () => {
          sockets.delete(socket);
          closed.resolve();
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      const ac = new AbortController();
      const reason = new Error('caller cancelled TLS body');
      const pending = request(
        (server.address() as net.AddressInfo).port,
        ac.signal,
      )
        .then((value) => ({ value }), (error) => ({ error }));
      try {
        await observed(accepted.promise, 'verified TLS connection');
        await observed(requested.promise, 'HTTP bytes received');
        if (outcome === 'abort') ac.abort(reason);
        if (outcome === 'body abort') {
          await observed(
            bodyReading.promise,
            'partial TLS body consumed before cancellation',
          );
          ac.abort(reason);
        }
        const result = await observed(pending, 'request settles');
        if (outcome === 'success') {
          assert('value' in result);
          assertEquals(new TextDecoder().decode(result.value.body), 'ok');
        } else {
          assert('error' in result);
          if (outcome === 'abort' || outcome === 'body abort') {
            assertStrictEquals(result.error, reason);
          } else {
            assert(result.error instanceof UpstreamError);
            assertEquals(result.error.category, 'protocol');
          }
        }
        // Observe the remote transport, before any test-side socket cleanup.
        await observed(closed.promise, 'TLS peer must close before cleanup');
      } finally {
        TlsConnection.prototype.read = read;
        ac.abort(reason);
        for (const socket of sockets) socket.destroy();
        await pending;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }

  Deno.test(`${caller}: initial TCP failure retains its transport phase`, async () => {
    // TCP destination zero has no listener; unlike a released ephemeral port,
    // it cannot be claimed by another fixture between selection and connect.
    const result = await request(0).then(() => null, (error) => error);
    assert(result instanceof UpstreamError);
    assertEquals(result.context.phase, caller === 'http1' ? 'connect' : 'tls');
  });

  for (
    const cancellation of [
      'abort',
      'total deadline',
      'connect deadline',
    ] as const
  ) {
    Deno.test(`${caller}: ${cancellation} releases an unanswered TLS handshake`, async () => {
      const hello = deferred(), closed = deferred();
      const sockets = new Set<net.Socket>();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.once('data', (bytes) => {
          assert(bytes.length > 0);
          hello.resolve();
        });
        socket.on('data', () => {});
        socket.on('error', () => {});
        socket.once('close', () => {
          sockets.delete(socket);
          closed.resolve();
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      const ac = new AbortController();
      const reason = new Error('caller cancelled TLS handshake');
      // Drive real policy timers only after the peer has consumed ClientHello.
      const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
      const timers: {
        id: ReturnType<typeof set>;
        active: boolean;
        fire: () => void;
      }[] = [];
      globalThis.setTimeout = Object.assign(
        (...args: Parameters<typeof set>) => {
          const [callback, ms, ...values] = args;
          if (ms !== 1001 && ms !== 2002) return set(...args);
          assert(typeof callback === 'function');
          const id = set(() => {}, 0);
          clear(id);
          const timer = {
            id,
            active: true,
            fire() {
              assert(timer.active);
              timer.active = false;
              callback(...values);
            },
          };
          timers.push(timer);
          return id;
        },
        set,
      );
      globalThis.clearTimeout = (id) => {
        const timer = timers.find((entry) => entry.id === id);
        if (timer) timer.active = false;
        clear(id);
      };
      const pending = request(
        (server.address() as net.AddressInfo).port,
        ac.signal,
        'localhost',
        [ca],
        { connectMs: 1001, timeoutMs: 2002 },
      )
        .then(() => null, (error) => error);
      try {
        await observed(hello.promise, 'actual ClientHello');
        assertEquals(timers.length, 2);
        assertEquals(
          timers[1].active,
          caller === 'federation',
          'only HTTP1 retires its TCP-only budget before TLS',
        );
        if (cancellation === 'connect deadline' && caller === 'http1') {
          // It must stay disarmed, not terminate the held handshake.
          ac.abort(reason);
        } else if (cancellation === 'abort') ac.abort(reason);
        else timers[cancellation === 'total deadline' ? 0 : 1].fire();
        const result = await observed(pending, 'cancellation identity');
        if (ac.signal.aborted) assertStrictEquals(result, reason);
        else {
          assert(result instanceof UpstreamError);
          assertEquals(
            result.context.phase,
            cancellation === 'total deadline' ? 'deadline' : 'connect',
          );
        }
        await observed(
          closed.promise,
          'aborted TLS peer must close before cleanup',
        );
      } finally {
        globalThis.setTimeout = set;
        globalThis.clearTimeout = clear;
        for (const timer of timers) clear(timer.id);
        ac.abort(reason);
        for (const socket of sockets) socket.destroy();
        await pending;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }

  for (
    const identity of [
      'localhost',
      null,
      '127.0.0.1',
      '[::1]',
      'wrong.invalid',
      'untrusted',
    ] as const
  ) {
    Deno.test(`${caller}: TLS identity ${identity ?? 'IP SAN'}`, async () => {
      let requests = 0;
      let servername: string | false | undefined;
      const context = tls.createSecureContext({ cert, key });
      const server = tls.createServer({
        cert,
        key,
        SNICallback(name, callback) {
          servername = name;
          callback(null, context);
        },
      }, (socket) => {
        socket.once('data', () => {
          requests++;
          socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
        });
        socket.on('error', () => {});
      });
      server.on('tlsClientError', () => {});
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      try {
        const result = await request(
          (server.address() as net.AddressInfo).port,
          undefined,
          identity === 'untrusted' ? 'localhost' : identity,
          identity === 'untrusted' ? [] : [ca],
        )
          .then((value) => value, (error) => error);
        if (
          identity === 'wrong.invalid' || identity === 'untrusted' ||
          identity === '[::1]'
        ) {
          assert(result instanceof UpstreamError);
          assertEquals(requests, 0);
        } else {
          assertEquals(
            result.status,
            200,
            'IP identity must verify without sending an IP literal SNI',
          );
          assertEquals(requests, 1);
          assertEquals(
            servername || false,
            identity === 'localhost' ? 'localhost' : false,
            'IP identity must verify without sending an IP literal SNI',
          );
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
}
