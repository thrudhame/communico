// tests/net-http1.test.ts — adversarial contract tests for the HTTP/1.1
// connection core: oversized headers, malformed chunked framing,
// slow-loris, size caps, mid-header close, connect timeout — and no
// leaked sockets (the test server counts its own open sockets).
import { assert, assertEquals } from '@std/assert';
import { http1Request } from '#engine/net/http1.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { latch, watchdog } from '#tests/support/ordering.ts';
import { controlledTimeouts } from '#tests/support/timers.ts';

type RawServer = {
  port: number;
  openSockets: () => number;
  close: () => void;
};

function serveRaw(
  handler: (conn: Deno.Conn) => Promise<void> | void,
): RawServer {
  const listener = Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  let open = 0;
  (async () => {
    try {
      for await (const conn of listener) {
        open++;
        (async () => {
          try {
            await handler(conn);
          } catch { /* client went away mid-handler */ }
          try {
            conn.close();
          } catch { /* already closed */ }
          open--;
        })();
      }
    } catch { /* listener closed */ }
  })();
  return {
    port,
    openSockets: () => open,
    close: () => {
      try {
        listener.close();
      } catch { /* already closed */ }
    },
  };
}

async function readRequest(
  conn: Deno.Conn,
): Promise<{ method: string; path: string; body: Uint8Array }> {
  const buf = new Uint8Array(64 * 1024);
  let n = 0;
  let sep = -1;
  while (n < buf.length) {
    const got = await conn.read(buf.subarray(n));
    if (got === null) break;
    n += got;
    sep = new TextDecoder('latin1').decode(buf.subarray(0, n)).indexOf(
      '\r\n\r\n',
    );
    if (sep >= 0) break;
  }
  const head = new TextDecoder('latin1').decode(buf.subarray(0, sep));
  const lines = head.split('\r\n');
  const [method, path] = lines[0].split(' ');
  let cl = 0;
  for (const line of lines.slice(1)) {
    if (line.toLowerCase().startsWith('content-length:')) {
      cl = Number(line.slice('content-length:'.length).trim());
    }
  }
  const body = new Uint8Array(cl);
  const leftover = buf.subarray(sep + 4, n);
  body.set(leftover.subarray(0, Math.min(leftover.length, cl)));
  let filled = Math.min(leftover.length, cl);
  while (filled < cl) {
    const got = await conn.read(body.subarray(filled));
    if (got === null) break;
    filled += got;
  }
  return { method, path, body };
}

function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<number> {
  return conn.write(data);
}

function get(
  port: number,
  opts: { maxBytes?: number; timeoutMs?: number; connectMs?: number } = {},
): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
  return http1Request({
    connectIp: '127.0.0.1',
    port,
    tls: null,
    hostHeader: 'localhost',
    method: 'GET',
    path: '/',
    headers: {},
    body: null,
    connectMs: opts.connectMs !== undefined ? opts.connectMs : 2000,
    timeoutMs: opts.timeoutMs !== undefined ? opts.timeoutMs : 2000,
    maxBytes: opts.maxBytes !== undefined ? opts.maxBytes : 1024 * 1024,
  });
}

async function waitClosed(srv: RawServer, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (srv.openSockets() === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assertEquals(srv.openSockets(), 0, 'sockets still open after budget');
}

Deno.test('http1: GET round trip with Content-Length framing', async () => {
  const srv = serveRaw(async (conn) => {
    await readRequest(conn);
    await writeAll(
      conn,
      new TextEncoder().encode(
        'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nX-Test: yes\r\n\r\nhello',
      ),
    );
  });
  try {
    const res = await get(srv.port);
    assertEquals(res.status, 200);
    assertEquals(new TextDecoder().decode(res.body), 'hello');
    assertEquals(res.headers.get('x-test'), 'yes');
  } finally {
    srv.close();
  }
  await waitClosed(srv, 3000);
});

Deno.test('http1: POST with a body sends Content-Length and the bytes', async () => {
  let seen: { method: string; path: string; body: Uint8Array } | null = null;
  const srv = serveRaw(async (conn) => {
    seen = await readRequest(conn);
    await writeAll(
      conn,
      new TextEncoder().encode(
        'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok',
      ),
    );
  });
  try {
    const res = await http1Request({
      connectIp: '127.0.0.1',
      port: srv.port,
      tls: null,
      hostHeader: 'localhost',
      method: 'POST',
      path: '/submit?x=1',
      headers: { 'Content-Type': 'application/json' },
      body: new TextEncoder().encode('{"a":1}'),
      connectMs: 2000,
      timeoutMs: 2000,
      maxBytes: 1024,
    });
    assertEquals(res.status, 200);
    assert(seen !== null);
    const s = seen as { method: string; path: string; body: Uint8Array };
    assertEquals(s.method, 'POST');
    assertEquals(s.path, '/submit?x=1');
    assertEquals(new TextDecoder().decode(s.body), '{"a":1}');
  } finally {
    srv.close();
  }
  await waitClosed(srv, 3000);
});

Deno.test('http1: valid chunked body is reassembled', async () => {
  const srv = serveRaw(async (conn) => {
    await readRequest(conn);
    await writeAll(
      conn,
      new TextEncoder().encode(
        'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' +
          '5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n',
      ),
    );
  });
  try {
    const res = await get(srv.port);
    assertEquals(new TextDecoder().decode(res.body), 'hello world');
  } finally {
    srv.close();
  }
  await waitClosed(srv, 3000);
});

Deno.test('http1: oversized headers error at the cap', async () => {
  const srv = serveRaw(async (conn) => {
    await writeAll(
      conn,
      new TextEncoder().encode(
        'HTTP/1.1 200 OK\r\nX-Pad: ' + 'x'.repeat(128 * 1024) + '\r\n\r\n',
      ),
    );
  });
  try {
    await get(srv.port);
    throw new Error('expected an error');
  } catch (e) {
    assert(e instanceof UpstreamError);
    assertEquals(e.category, 'validation');
    assert(e.message.includes('headers too large'));
  } finally {
    srv.close();
  }
  await waitClosed(srv, 3000);
});

Deno.test('http1: malformed chunk size errors, no hang', async () => {
  const srv = serveRaw(async (conn) => {
    await readRequest(conn);
    await writeAll(
      conn,
      new TextEncoder().encode(
        'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZZZ\r\n',
      ),
    );
  });
  try {
    await get(srv.port, { timeoutMs: 1500 });
    throw new Error('expected an error');
  } catch (e) {
    assert(e instanceof UpstreamError);
    assertEquals(e.category, 'protocol');
    assert(e.message.includes('bad chunk size'));
  } finally {
    srv.close();
  }
  await waitClosed(srv, 3000);
});

Deno.test('http1: slow-loris body fires the total timeout', async () => {
  const srv = serveRaw(async (conn) => {
    await readRequest(conn);
    await writeAll(
      conn,
      new TextEncoder().encode(
        'HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n',
      ),
    );
    // drip one byte at a time, far slower than the client's budget
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      await writeAll(conn, new Uint8Array([65]));
    }
  });
  const t0 = Date.now();
  try {
    await get(srv.port, { timeoutMs: 400 });
    throw new Error('expected an error');
  } catch (e) {
    const ms = Date.now() - t0;
    assert(e instanceof UpstreamError);
    assertEquals(e.category, 'transport');
    assert(
      e.message.includes('timeout'),
      `message: ${e.message}`,
    );
    assert(ms < 3000, `took ${ms}ms`);
  } finally {
    srv.close();
  }
  await waitClosed(srv, 3000);
});

Deno.test('http1: Content-Length over maxBytes errors immediately', async () => {
  const srv = serveRaw(async (conn) => {
    await readRequest(conn);
    await writeAll(
      conn,
      new TextEncoder().encode(
        'HTTP/1.1 200 OK\r\nContent-Length: 5000\r\n\r\n',
      ),
    );
  });
  try {
    await get(srv.port, { maxBytes: 1024 });
    throw new Error('expected an error');
  } catch (e) {
    assert(e instanceof UpstreamError);
    assertEquals(e.category, 'validation');
    assertEquals(e.context.resourceLimit, true);
  } finally {
    srv.close();
  }
  await waitClosed(srv, 3000);
});

Deno.test('http1: EOF body over maxBytes errors after exactly maxBytes, before EOF', async () => {
  const eof = latch(), sent = latch(), joined = latch();
  const timers = controlledTimeouts(2000);
  const srv = serveRaw(async (conn) => {
    try {
      await readRequest(conn);
      await writeAll(conn, new TextEncoder().encode('HTTP/1.1 200 OK\r\n\r\n'));
      await writeAll(conn, new Uint8Array(700));
      await writeAll(conn, new Uint8Array(700));
      sent.release();
      await eof.wait;
    } finally {
      joined.release();
    }
  });
  const pending = get(srv.port, { maxBytes: 1024 }).then(
    () => 'unexpected success',
    (error) => error,
  );
  try {
    await watchdog(sent.wait, 'peer body bytes before withheld EOF');
    const e = await watchdog(
      pending,
      'byte limit rejects while peer EOF is withheld',
    );
    assert(e instanceof UpstreamError);
    assertEquals(e.category, 'validation');
    assertEquals(e.context.resourceLimit, true);
    assertEquals(eof.released, false, 'byte limit must not wait for EOF');
  } finally {
    eof.release();
    await pending;
    await joined.wait;
    timers.restore();
    srv.close();
  }
  await waitClosed(srv, 3000);
});

Deno.test('http1: connection closed mid-headers errors', async () => {
  const srv = serveRaw(async (conn) => {
    await readRequest(conn);
    await writeAll(
      conn,
      new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-'),
    );
  });
  try {
    await get(srv.port);
    throw new Error('expected an error');
  } catch (e) {
    assert(e instanceof UpstreamError);
    assertEquals(e.category, 'protocol');
    assertEquals(e.context.reason, 'upstream headers truncated');
  } finally {
    srv.close();
  }
  await waitClosed(srv, 3000);
});

Deno.test('http1: connect timeout on a blackholed address', async () => {
  const t0 = Date.now();
  try {
    await http1Request({
      connectIp: '10.255.255.1',
      port: 8448,
      tls: null,
      hostHeader: 'x',
      method: 'GET',
      path: '/',
      headers: {},
      body: null,
      connectMs: 300,
      timeoutMs: 3000,
      maxBytes: 1024,
    });
    throw new Error('expected an error');
  } catch (e) {
    const ms = Date.now() - t0;
    assert(e instanceof UpstreamError);
    assertEquals(e.category, 'transport');
    assert(ms < 3000, `took ${ms}ms`);
  }
});

Deno.test('http1: the total deadline closes a stalled upgraded TLS connection', async () => {
  let peer: Deno.Conn | undefined;
  const hello = latch(), closed = latch();
  const timers = controlledTimeouts(100);
  const srv = serveRaw(async (conn) => {
    peer = conn;
    const buffer = new Uint8Array(4096);
    try {
      assert((await conn.read(buffer))! > 0, 'actual ClientHello received');
      hello.release();
      while (await conn.read(buffer) !== null) { /* never answer handshake */ }
    } catch (error) {
      if (!(error instanceof Deno.errors.ConnectionReset)) throw error;
    } finally {
      closed.release();
    }
  });
  const pending = http1Request({
    connectIp: '127.0.0.1',
    port: srv.port,
    tls: { sni: 'localhost', caCerts: [] },
    hostHeader: 'localhost',
    method: 'GET',
    path: '/',
    headers: {},
    body: null,
    connectMs: 100,
    timeoutMs: 100,
    maxBytes: 1024,
  }).then(() => 'unexpected success', (error) => error);
  try {
    await watchdog(
      hello.wait,
      'TLS peer receives ClientHello before total deadline',
    );
    assertEquals(
      timers.timers.length,
      2,
      'total and connect deadlines register independently',
    );
    assertEquals(
      timers.timers[1].active,
      false,
      'TCP connect deadline is retired',
    );
    timers.timers[0].fire();
    const outcome = await watchdog(
      pending,
      'total deadline rejects unanswered TLS handshake',
    );
    assert(outcome instanceof UpstreamError, String(outcome));
    assertEquals(outcome.category, 'transport');
    assertEquals(outcome.context.phase, 'deadline');
    assert(outcome.message.includes('timeout'));
    await watchdog(closed.wait, 'total deadline closes the actual TLS peer');
  } finally {
    try {
      peer?.close();
    } catch { /* already closed */ }
    srv.close();
    await pending;
    timers.restore();
    await waitClosed(srv, 3000);
  }
});
