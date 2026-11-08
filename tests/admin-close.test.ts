import { assert, assertEquals } from '@std/assert';
import { bounded, serverProcess } from './helpers/server-process.ts';

Deno.test('200 cross-process tool, request-abort and stale-probe closes preserve admin and CS', async () => {
  const server = await serverProcess();
  try {
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--allow-net',
        '--allow-read',
        '--allow-write',
        '--allow-env',
        'tests/fixtures/admin-close-child.ts',
        server.socket,
        String(server.port),
      ],
      env: { COMMUNICO_CONFIG: server.config },
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    const output = await bounded(child.output(), 60000);
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    assert(
      new TextDecoder().decode(output.stdout).includes(
        '200 cross-process close/abort/probe iterations passed',
      ),
    );
    const tool = await new Deno.Command(Deno.execPath(), {
      args: ['task', 'federation-block', '--', 'list'],
      env: { COMMUNICO_CONFIG: server.config },
    }).output();
    assertEquals(tool.code, 0, new TextDecoder().decode(tool.stderr));
    assertEquals((await server.api('versions')).status, 200);
    server.child.kill('SIGTERM');
    const out = await bounded(server.output);
    assertEquals(out.code, 0, out.stderr);
    assert(!/unhandled|Uncaught \(in promise\)/i.test(out.stderr), out.stderr);
    assert(!out.stderr.includes('forced aborts'), out.stderr);
    assertEquals(await Deno.lstat(server.socket).catch(() => null), null);
  } finally {
    await server.dispose();
  }
});
