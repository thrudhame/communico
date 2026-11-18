import { assert, assertEquals } from '@std/assert';
import {
  bounded,
  partialRequest,
  pause,
  serverProcess,
} from './helpers/server-process.ts';

Deno.test('SIGTERM drains admin JSON and CS upload before closing the store', async () => {
  const server = await serverProcess();
  try {
    const input = { username: 'drain', password: 'drain-password' };
    const challenge = await server.api('v3/register', input);
    const registered = await server.api('v3/register', {
      ...input,
      auth: { type: 'm.login.dummy', session: challenge.body.session },
    });
    assertEquals(registered.status, 200);
    const token = registered.body.access_token;
    const admin = await partialRequest(server, '/v1/status', '{}');
    const upload = await partialRequest(
      { port: server.port },
      '/_matrix/media/v3/upload',
      'drained upload',
      `Authorization: Bearer ${token}\r\nContent-Type: text/plain\r\n`,
    );
    await pause(100);
    server.child.kill('SIGTERM');
    await server.waitLog('shutdown: draining');
    const refused = await server.api('versions');
    assertEquals(refused.status, 503);
    assertEquals(refused.body.errcode, 'M_UNKNOWN');
    const refusedAdmin = await partialRequest(server, '/v1/status', '{}');
    assert((await refusedAdmin.finish()).includes('UNAVAILABLE'));
    const [a, u] = await Promise.all([admin.finish(), upload.finish()]);
    assert(a.startsWith('HTTP/1.1 200'), a);
    assert(a.includes('"ok":true'), a);
    assert(u.startsWith('HTTP/1.1 200'), u);
    assert(u.includes('content_uri'), u);
    const out = await bounded(server.output);
    assertEquals(out.code, 0, out.stderr);
    assert(out.stdout.includes('shutdown: store closed'));
    assert(!out.stderr.includes('forced aborts'));
    assertEquals(await Deno.lstat(server.socket).catch(() => null), null);
    const files = [];
    for await (const entry of Deno.readDir(`${server.dir}/media`)) {
      files.push(entry);
    }
    assert(files.length > 0, 'upload did not reach the media store');
  } finally {
    await server.dispose();
  }
});

Deno.test('shutdown deadline closes unread transports retryably and closes the store successfully', async () => {
  const server = await serverProcess({ grace: 1 });
  const request = await partialRequest(
    server,
    '/v1/status',
    '{"unfinished":true}',
  );
  const response = (async () => {
    const reader = request.conn.readable.getReader();
    let wire = '';
    try {
      for (;;) {
        const { value, done } = await bounded(reader.read());
        if (done) return wire;
        wire += new TextDecoder().decode(value);
      }
    } catch (error) {
      if (
        error instanceof Deno.errors.ConnectionReset ||
        error instanceof Deno.errors.ConnectionAborted
      ) return wire;
      throw error;
    } finally {
      reader.releaseLock();
    }
  })();
  // The wire may settle before process output; retain its rejection for the
  // assertion below instead of creating an unhandled test-side promise.
  void response.catch(() => {});
  try {
    await pause(100);
    server.child.kill('SIGINT');
    const out = await bounded(server.output, 10000);
    assertEquals(out.code, 0, out.stderr);
    const wire = await bounded(response);
    // Synapse stops listeners (synapse/server.py:461-469), then closes active
    // transports (synapse/http/site.py:927-938). An unread body at grace expiry
    // likewise ends in retryable EOF/reset, not a promised HTTP response.
    assertEquals(wire, '');
    assert(
      out.stderr.includes('shutdown: forced aborts {"admin":1}'),
      out.stderr,
    );
    assert(out.stdout.includes('shutdown: store closed'));
    assertEquals(await Deno.lstat(server.socket).catch(() => null), null);
  } finally {
    try {
      request.conn.close();
    } catch (error) {
      assert(error instanceof Deno.errors.BadResource, String(error));
    }
    await server.dispose();
  }
});
