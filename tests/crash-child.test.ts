import { assert, assertEquals, assertRejects } from '@std/assert';
import { runCrashChild } from './crash-child.ts';

function command(source: string) {
  return new Deno.Command(Deno.execPath(), {
    args: ['eval', source],
    stdout: 'piped',
    stderr: 'piped',
  });
}

Deno.test('crash child lifetime bounds silent children including a closed stdout pipe', async () => {
  for (
    const source of [
      'setInterval(() => {}, 1000)',
      'Deno.stdout.close(); setInterval(() => {}, 1000)',
    ]
  ) {
    const started = performance.now();
    const result = await runCrashChild<{ row: number }>(command(source), {
      deadlineMs: 250,
      onEvent: () => {},
    });
    assertEquals(result.reason, 'watchdog');
    assertEquals(result.status.signal, 'SIGKILL');
    assert(
      performance.now() - started < 3000,
      'absolute child deadline exceeded',
    );
  }
});

Deno.test('crash child drains stderr flood within a readiness-relative progress window', async () => {
  let readyAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rows = 0;
  try {
    const result = await runCrashChild<{ ready?: boolean; row?: number }>(
      command(
        'await new Promise(r => setTimeout(r,600)); console.log(JSON.stringify({ready:true})); for (;;) { await Deno.stderr.write(new Uint8Array(65536)); console.log(JSON.stringify({row:1})); }',
      ),
      {
        deadlineMs: 3000,
        onEvent: (event, stop) => {
          if (event.ready) {
            readyAt = performance.now();
            timer = setTimeout(() => stop('checkpoint'), 250);
          } else rows++;
        },
      },
    );
    assert(readyAt !== null, 'child never reached readiness');
    assertEquals(result.reason, 'checkpoint');
    assertEquals(result.status.signal, 'SIGKILL');
    assert(rows > 0, 'stderr backpressure blocked stdout after readiness');
    assert(result.stderr.length > 0, 'stderr was actually drained');
    assert(
      performance.now() - readyAt < 2000,
      'readiness-relative pipe window exceeded',
    );
  } finally {
    clearTimeout(timer);
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
