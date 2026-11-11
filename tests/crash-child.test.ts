import { assert, assertEquals, assertRejects } from '@std/assert';
import { runCrashChild } from './crash-child.ts';

function command(source: string) {
  return new Deno.Command(Deno.execPath(), {
    args: ['eval', source],
    stdout: 'piped',
    stderr: 'piped',
  });
}

Deno.test('crash child lifetime bounds silent and noisy children and drains both pipes', async () => {
  for (
    const source of [
      'setInterval(() => {}, 1000)',
      'Deno.stdout.close(); setInterval(() => {}, 1000)',
      'for (;;) { await Deno.stderr.write(new Uint8Array(65536)); console.log(JSON.stringify({row:1})); }',
    ]
  ) {
    const started = performance.now();
    let rows = 0;
    const result = await runCrashChild<{ row: number }>(command(source), {
      deadlineMs: 250,
      onEvent: () => rows++,
    });
    assertEquals(result.reason, 'watchdog');
    assertEquals(result.status.signal, 'SIGKILL');
    assert(
      performance.now() - started < 3000,
      'absolute child deadline exceeded',
    );
    if (source.includes('stderr')) {
      assert(rows > 0, 'stderr backpressure blocked stdout');
    }
  }
});

Deno.test('crash child owns kill reason, final unterminated lines, cleanup and parse failure', async () => {
  const events: number[] = [];
  const natural = await runCrashChild<{ row: number }>(
    command('Deno.stdout.writeSync(new TextEncoder().encode("{\\"row\\":7}"))'),
    {
      deadlineMs: 2000,
      onEvent: (event) => events.push(event.row),
    },
  );
  assertEquals(events, [7]);
  assertEquals(natural.reason, 'exited');
  const aimed = await runCrashChild(
    command('console.log("{}"); setInterval(() => {},1000)'),
    {
      deadlineMs: 2000,
      onEvent: (_event, stop) => stop('checkpoint'),
    },
  );
  assertEquals(aimed.reason, 'checkpoint');
  await assertRejects(
    () =>
      runCrashChild(
        command('console.log("not-json"); setInterval(() => {},1000)'),
        {
          deadlineMs: 2000,
          onEvent: () => {},
        },
      ),
    SyntaxError,
  );
});
