import { assert, assertEquals } from '@std/assert';

Deno.test('every process helper retains stdout and stderr after an external assertion and fixture cleanup', async () => {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      'test',
      '--allow-all',
      'tests/fixtures/child-diagnostics-failure.ts',
    ],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(result.code, 1, 'the fixture must really fail');
  const text = new TextDecoder().decode(result.stdout) +
    new TextDecoder().decode(result.stderr);
  assert(text.includes('outside-helper assertion marker'));
  const fixtures = [...text.matchAll(/disposed fixture: (.+)/g)].map((m) =>
    m[1].trim()
  );
  assertEquals(fixtures.length, 2, 'both ordinary cleanup paths completed');
  for (const path of fixtures) {
    assertEquals(await Deno.lstat(path).catch(() => null), null);
  }
  const paths = [...text.matchAll(/child diagnostics: (.+)/g)].map((m) =>
    m[1].trim()
  );
  assertEquals(paths.length, 3, 'two server children and one facade child');
  for (const path of paths) {
    const stdout = await Deno.readTextFile(path + '/stdout.log');
    const stderr = await Deno.readTextFile(path + '/stderr.log');
    assert(stdout.includes('federation: disabled'), path);
    assert(stderr.includes('Listening on'), path);
    assert(
      !stdout.includes('facade-test:'),
      'private observations are not diagnostic logs',
    );
    await Deno.remove(path, { recursive: true });
  }
});
