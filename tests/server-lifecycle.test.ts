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

Deno.test('shutdown deadline aborts unread bodies and exits non-zero with counts', async () => {
  const server = await serverProcess({ grace: 1 });
  const request = await partialRequest(
    server,
    '/v1/status',
    '{"unfinished":true}',
  );
  try {
    await pause(100);
    server.child.kill('SIGINT');
    const out = await bounded(server.output, 10000);
    assert(out.code !== 0);
    assert(
      out.stderr.includes('shutdown: forced aborts {"admin":1}'),
      out.stderr,
    );
    assert(out.stdout.includes('shutdown: store closed'));
    assertEquals(await Deno.lstat(server.socket).catch(() => null), null);
  } finally {
    request.conn.close();
    await server.dispose();
  }
});
