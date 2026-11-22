import { DiagnosticCommand } from '#tests/helpers/child-diagnostics.ts';
import { assert, assertEquals } from '@std/assert';

Deno.test('command runner retains child exception text and exit cause independently of caller assertions', async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    const output = await new DiagnosticCommand(Deno.execPath(), {
      args: ['eval', 'throw new TypeError("child-exception-marker")'],
    }).output();
    assertEquals(output.code, 1);
    const path = lines.find((line) => line.startsWith('child diagnostics: '))!
      .slice('child diagnostics: '.length);
    const stderr = await Deno.readTextFile(path + '/stderr.log');
    assert(stderr.includes('TypeError: child-exception-marker'));
    assert(stderr.includes('at '));
    assertEquals(JSON.parse(await Deno.readTextFile(path + '/status.json')), {
      success: false,
      code: 1,
      signal: null,
    });
    await Deno.remove(path, { recursive: true });
  } finally {
    console.error = original;
  }
});

Deno.test('all fixture command constructors use retained diagnostics owners', async () => {
  async function check(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const path = dir + '/' + entry.name;
      if (entry.isDirectory) await check(path);
      else if (entry.name.endsWith('.ts')) {
        const text = await Deno.readTextFile(path);
        if (
          ['tests/helpers/server-process.ts', 'tests/helpers/facade-process.ts']
            .includes(path)
        ) {
          assert(text.includes('diagnostics.status(status)'), path);
        } else {
          assert(!/new\s+Deno[.]Command\s*\(/.test(text), path);
        }
      }
    }
  }
  await check('tests');
});

Deno.test('every process helper retains stdout and stderr after an external assertion and fixture cleanup', async () => {
  const result = await new DiagnosticCommand(Deno.execPath(), {
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
    const status = JSON.parse(await Deno.readTextFile(path + '/status.json'));
    assertEquals(typeof status.code, 'number');
    assertEquals(typeof status.success, 'boolean');
    assert(Object.hasOwn(status, 'signal'));
    assert(stdout.includes('federation: disabled'), path);
    assert(stderr.includes('Listening on'), path);
    assert(
      !stdout.includes('facade-test:'),
      'private observations are not diagnostic logs',
    );
    await Deno.remove(path, { recursive: true });
  }
});
