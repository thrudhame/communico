// Invoked only by child-diagnostics.test.ts: the assertion deliberately fails
// outside the process helper, and ordinary fixture cleanup must still run.
import { assertEquals } from '@std/assert';
import { serverProcess } from '#tests/helpers/server-process.ts';
import { facadeProcess } from '#tests/helpers/facade-process.ts';

for (const kind of ['server', 'facade']) {
  Deno.test(
    'retain child evidence after ' + kind + ' fixture failure',
    async () => {
      const server = await serverProcess();
      let facade: Awaited<ReturnType<typeof facadeProcess>> | undefined;
      try {
        if (kind === 'facade') {
          server.child.kill('SIGTERM');
          await server.output;
          facade = await facadeProcess(server.config, 'federation: disabled');
          await facade.listening(server.port);
          await facade.fence();
        }
        assertEquals('actual', 'expected', 'outside-helper assertion marker');
      } finally {
        await facade?.dispose();
        await server.dispose();
        console.log('disposed fixture: ' + server.dir);
      }
    },
  );
}
