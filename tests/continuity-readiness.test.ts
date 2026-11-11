import { assert, assertEquals } from '@std/assert';

Deno.test('continuity readiness has one elapsed budget for never, late and slow probes', async () => {
  for (const probe of ['exit 1', 'sleep 1.2; exit 0', 'sleep 5; exit 1']) {
    const start = performance.now();
    const out = await new Deno.Command('bash', {
      args: [
        '-c',
        'source complement/readiness.sh; wait_ready_within 1 bash -c "$1"',
        'fixture',
        probe,
      ],
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assertEquals(out.code, 1, new TextDecoder().decode(out.stderr));
    assert(performance.now() - start < 2500, `probe exceeded budget: ${probe}`);
  }
  const ready = await new Deno.Command('bash', {
    args: ['-c', 'source complement/readiness.sh; wait_ready_within 2 true'],
  }).output();
  assertEquals(ready.code, 0);
});
