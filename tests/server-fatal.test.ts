import { assert, assertEquals } from '@std/assert';
import { bounded, serverProcess } from './helpers/server-process.ts';

for (const fatal of ['close', 'hang', 'second'] as const) {
  Deno.test(`unhandled rejection is fatal with stack, closed admission and bounded cleanup (${fatal})`, async () => {
    const server = await serverProcess({ fatal });
    try {
      const started = performance.now();
      const exited = server.output.then((output) => ({
        output,
        at: performance.now(),
      }));
      await Deno.writeTextFile(`${server.dir}/fatal-trigger`, 'reject');
      await server.waitLog('fatal: unhandled rejection');
      for (let i = 0; i < 5; i++) {
        try {
          const response = await fetch(
            `http://127.0.0.1:${server.port}/_matrix/client/versions`,
            { signal: AbortSignal.timeout(250) },
          );
          assertEquals(
            response.status,
            503,
            'server served after the fatal marker',
          );
          await response.body?.cancel();
        } catch (error) {
          // Refused/reset/aborted connections are expected after transports
          // close. Never swallow an assertion failure about a served response.
          if (error instanceof Error && error.name === 'AssertionError') {
            throw error;
          }
        }
      }
      const tool = await new Deno.Command(Deno.execPath(), {
        args: ['task', 'federation-block', '--', 'list'],
        env: { COMMUNICO_CONFIG: server.config },
      }).output();
      assertEquals(tool.code, 1, 'admin still serves after the fatal marker');
      // A slow observer must not extend the measured server exit deadline.
      await new Promise((resolve) => setTimeout(resolve, 3600));
      const { output, at } = await bounded(exited, 5000);
      const elapsed = at - started;
      assertEquals(output.code, 1, output.stderr);
      assert(output.stderr.includes('fatal: unhandled rejection'));
      assert(output.stderr.includes('Error: fatal-test-rejection'));
      assert(output.stderr.includes('at '), output.stderr);
      assert(elapsed < 3500, `fatal exit took ${elapsed}ms`);
      if (fatal === 'close') {
        assert(output.stderr.includes('fatal: store closed'), output.stderr);
      } else {
        assert(output.stdout.includes('test: store close held'));
        assert(!output.stderr.includes('fatal: store closed'));
        if (fatal === 'hang') {
          assert(elapsed >= 1900, `deadline did not wait: ${elapsed}ms`);
        } else {assert(
            elapsed < 1500,
            `second rejection did not exit immediately: ${elapsed}ms`,
          );}
      }
      assertEquals(await Deno.lstat(server.socket).catch(() => null), null);
    } finally {
      await server.dispose();
    }
  });
}
