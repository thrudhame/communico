import { assert, assertEquals } from '@std/assert';
import versions from '#endpoints/matrix/_matrix/client/versions/get.ts';
import {
  assertConsumptionProofs,
  consumptionProofs,
} from '#tests/spec-consumption.ts';

const root = new URL('../', import.meta.url);
const expected = Array.from({ length: 16 }, (_, i) => `v1.${i + 1}`);

function contractSuites(checklist: string): string[] {
  return [
    ...new Set(
      checklist.split('\n').filter((line) => /^\|\s+\d+\s+\|\s+v1\./.test(line))
        .flatMap((
          line,
        ) => [...(line.split('|')[4] ?? '').matchAll(/`([\w-]+)`/g)])
        .map((match) => match[1]),
    ),
  ];
}

Deno.test('version suite parsing ignores prose and other table columns', () => {
  assertEquals(
    contractSuites([
      'Prose references `http-not-a-suite`.',
      '| 1 | v1.1 | A contract mentioning `http-not-a-suite` | `http-sync`, `e2ee-keys` |',
      '| 2 | v1.2 | More | `http-sync`, `http-room-read` |',
      '| 1 | `http-unrelated-table` | Other table |',
    ].join('\n')),
    ['http-sync', 'e2ee-keys', 'http-room-read'],
  );
});

Deno.test('versions advertisement is cumulative and retains its endpoint/contract checklist', async () => {
  assertEquals((await versions()).versions, expected);
  const checklist = await Deno.readTextFile(
    new URL('MATRIX-VERSIONS.md', root),
  );
  const rows = checklist.split('\n').filter((line) =>
    /^\|\s+\d+\s+\|\s+v1\./.test(line)
  );
  assertEquals(rows.map((line) => line.split('|')[2].trim()), expected);
  const endpoints = JSON.parse(
    await Deno.readTextFile(
      new URL('tests/fixtures/versions-endpoints.json', root),
    ),
  ) as {
    method: string;
    path: string;
    routes: string[];
    status: string;
    reason: string;
  }[];
  assertEquals(endpoints.length, 197);
  assertEquals(endpoints.filter((e) => e.status === 'Routed').length, 174);
  for (const endpoint of endpoints) {
    if (endpoint.status !== 'Routed') {
      assert(
        endpoint.reason,
        `${endpoint.method} ${endpoint.path}: exclusion needs a reason`,
      );
      continue;
    }
    assert(
      endpoint.routes.length,
      `${endpoint.method} ${endpoint.path}: missing route`,
    );
    for (const route of endpoint.routes) {
      assert(route.startsWith('api/endpoints/matrix/'));
      assert(route.endsWith('/' + endpoint.method.toLowerCase() + '.ts'));
      // URL construction must not interpret Pathfinder's #parameters as fragments.
      const url = new URL(route.replaceAll('#', '%23'), root);
      const handler = await import(url.href);
      assertEquals(typeof handler.default, 'function', route);
    }
  }
});

Deno.test('advertised version behavioral checklist executes at the real consumers', async () => {
  const checklist = await Deno.readTextFile(
    new URL('MATRIX-VERSIONS.md', root),
  );
  const files = [
    ...new Set([
      ...contractSuites(checklist),
      ...consumptionProofs().map((proof) => proof.suite),
    ]),
  ];
  assert(files.length > 20, 'behavioral checklist must not become empty');
  const dir = await Deno.makeTempDir({ prefix: 'versions-contracts-' });
  try {
    const output = await new Deno.Command(Deno.execPath(), {
      cwd: root,
      args: [
        'test',
        '--no-check',
        '--allow-net',
        '--allow-env',
        '--allow-read',
        '--allow-write',
        '--allow-run',
        '--allow-ffi',
        '--allow-sys=uid,umask,ca',
        '--junit-path=' + dir + '/results.xml',
        ...files.map((file) => `tests/${file}.test.ts`),
      ],
      env: { NO_COLOR: '1' },
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    const text = new TextDecoder().decode(output.stdout) +
      new TextDecoder().decode(output.stderr);
    assertEquals(output.code, 0, text);
    const result = await Deno.readTextFile(dir + '/results.xml');
    assertConsumptionProofs(result);
    assert(
      !result.includes('<skipped'),
      'version contracts must not be skipped',
    );
    for (const file of files) {
      assert(
        new RegExp(
          `running [1-9][0-9]* tests? from \\./tests/${file}\\.test\\.ts`,
        ).test(text),
        `${file}: no executed contract suite`,
      );
    }
    const cases = [
      ...checklist.matchAll(
        /^\|\s+\d+\s+\|\s+`http-[^`]+`\s+\|\s+`([^`]+)`\s+\|$/gm,
      ),
    ];
    assertEquals(cases.length, 4);
    for (const [, name] of cases) {
      assert(
        result.includes(name),
        `required inherited contract did not run: ${name}`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
