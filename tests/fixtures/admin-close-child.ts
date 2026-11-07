// A second process drives the real shared node:http client (agent: false),
// abrupt request writers and the same connect/close used by the stale probe.
import { assert, assertEquals } from '@std/assert';
import { adminRequest } from '#root/tools/admin-client.ts';

const [socket, port] = Deno.args;
const base = `http://127.0.0.1:${port}`;
const encoder = new TextEncoder();
async function closeRequest(body: string, advertised: number) {
  const connection = await Deno.connect({ transport: 'unix', path: socket });
  const bytes = encoder.encode(
    `POST /v1/status HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: ${advertised}\r\n\r\n${body}`,
  );
  let n = 0;
  while (n < bytes.length) n += await connection.write(bytes.subarray(n));
  connection.close();
}
for (let iteration = 0; iteration < 200; iteration++) {
  const status = await adminRequest<{ server: string; uptime: number }>(
    'status',
  );
  assert(status.server.length > 0 && status.uptime >= 0);
  // Close with half a declared JSON body, then after the whole request has
  // been written but before reading any response.
  await closeRequest('{"partial":', 22);
  await closeRequest('{}', 2);
  const probe = await Deno.connect({ transport: 'unix', path: socket });
  probe.close();
  assert(
    (await adminRequest<{ server: string }>('status')).server === status.server,
  );
  const response = await fetch(base + '/_matrix/client/versions');
  assertEquals(response.status, 200);
  assert(Array.isArray((await response.json()).versions));
}
console.log('200 cross-process close/abort/probe iterations passed');
