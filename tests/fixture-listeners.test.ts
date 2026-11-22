import { assert, assertEquals, assertThrows } from '@std/assert';
import { serverProcess } from './helpers/server-process.ts';

Deno.test('fixture ports belong to the child listener, never a released reservation', async () => {
  const server = await serverProcess();
  try {
    const config = await Deno.readTextFile(server.config);
    assert(
      config.includes(`\nport=${server.port}\n`),
      'remember the child-owned live binding for later fixture restarts',
    );
    assert(server.port > 0);
    assertThrows(
      () => Deno.listen({ hostname: '127.0.0.1', port: server.port }),
      Deno.errors.AddrInUse,
    );
    assertEquals((await server.api('versions')).status, 200);
  } finally {
    await server.dispose();
  }
});
