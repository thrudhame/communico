// tests/config.test.ts — the config loader: merge order, leaf-only env,
// strict types, full error listing, COMMUNICO_CONFIG, absent overlay, shell
// quoting. Pure: temp files, no DB, no server.
import { assert, assertEquals } from '@std/assert';
import { dirname } from '@std/path';
import {
  coerceEnv,
  ConfigError,
  formatShellExports,
  loadConfig,
  resolvePaths,
} from '#engine/config.ts';

const FULL = `[server]
name = "localhost"
port = 8008

[db]
host = "127.0.0.1"
port = 5432
user = "root"
pass = "secret"
name = "postgres"

[media]
root = "./.media"
maxbytes = 52428800
`;

async function writeTree(
  files: Record<string, string>,
): Promise<string> {
  const dir = await Deno.makeTempDir();
  for (const [rel, body] of Object.entries(files)) {
    const path = `${dir}/${rel}`;
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, body);
  }
  return dir;
}

function loadFail(opts: Parameters<typeof loadConfig>[0]): string[] {
  try {
    loadConfig(opts);
    throw new Error('expected ConfigError');
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
}

Deno.test('merge order: defaults < config < env', async () => {
  const dir = await writeTree({
    'defaults/communico.toml': FULL,
    'config/communico.toml': '[server]\nport = 8009\n',
  });
  const defaultsPath = `${dir}/defaults/communico.toml`;
  const configPath = `${dir}/config/communico.toml`;
  const fromDefaults = loadConfig({
    defaultsPath,
    configPath: null,
    env: {},
  });
  assertEquals(fromDefaults.config.server.port, 8008);
  assertEquals(fromDefaults.sources['server.port'], 'defaults');
  const fromConfig = loadConfig({
    defaultsPath,
    configPath,
    env: {},
  });
  assertEquals(fromConfig.config.server.port, 8009);
  assertEquals(fromConfig.sources['server.port'], 'config');
  const fromEnv = loadConfig({
    defaultsPath,
    configPath,
    env: { COMMUNICO_SERVER_PORT: '8010' },
  });
  assertEquals(fromEnv.config.server.port, 8010);
  assertEquals(fromEnv.sources['server.port'], 'env');
  assertEquals(fromEnv.config.server.name, 'localhost');
  assertEquals(fromEnv.sources['server.name'], 'defaults');
});

Deno.test('section env is an error; unknown node in env and in a file', async () => {
  const dir = await writeTree({
    'defaults/communico.toml': FULL,
    'config/communico.toml': '[media]\nlimit = 1\n',
  });
  const defaultsPath = `${dir}/defaults/communico.toml`;
  const section = loadFail({
    defaultsPath,
    configPath: null,
    env: { COMMUNICO_MEDIA: '1' },
  });
  assert(
    section.some((p) =>
      p.includes('COMMUNICO_MEDIA') && p.includes('names a section')
    ),
    `section: ${section.join('\n')}`,
  );
  const unknownEnv = loadFail({
    defaultsPath,
    configPath: null,
    env: { COMMUNICO_MEDIA_NOSUCH: '1' },
  });
  assert(
    unknownEnv.some((p) =>
      p.includes('COMMUNICO_MEDIA_NOSUCH') && p.includes('unknown node')
    ),
    `unknown env: ${unknownEnv.join('\n')}`,
  );
  const unknownFile = loadFail({
    defaultsPath,
    configPath: `${dir}/config/communico.toml`,
    env: {},
  });
  assert(
    unknownFile.some((p) => p.includes('unknown node media.limit')),
    `unknown file: ${unknownFile.join('\n')}`,
  );
});

Deno.test('type strictness: bool TRUE/1 rejected; int 8008.0/abc rejected; list split+trim', () => {
  assertEquals(coerceEnv('bool', 'true'), { ok: true, value: true });
  assertEquals(coerceEnv('bool', 'false'), { ok: true, value: false });
  assertEquals(coerceEnv('bool', 'TRUE').ok, false);
  assertEquals(coerceEnv('bool', '1').ok, false);
  assertEquals(coerceEnv('int', '8008'), { ok: true, value: 8008 });
  assertEquals(coerceEnv('int', '8008.0').ok, false);
  assertEquals(coerceEnv('int', 'abc').ok, false);
  assertEquals(coerceEnv('list', ' a, b , '), {
    ok: true,
    value: ['a', 'b'],
  });
  assertEquals(coerceEnv('list', ''), { ok: true, value: [] });
});

Deno.test('int env 8008.0 and abc fail loadConfig naming the leaf', async () => {
  const dir = await writeTree({ 'defaults/communico.toml': FULL });
  const defaultsPath = `${dir}/defaults/communico.toml`;
  const dotted = loadFail({
    defaultsPath,
    configPath: null,
    env: { COMMUNICO_SERVER_PORT: '8008.0' },
  });
  assert(
    dotted.some((p) =>
      p.includes('server.port') && p.includes('COMMUNICO_SERVER_PORT') &&
      p.includes('expected int') && p.includes('from env')
    ),
    `dotted: ${dotted.join('\n')}`,
  );
  const abc = loadFail({
    defaultsPath,
    configPath: null,
    env: { COMMUNICO_SERVER_PORT: 'abc' },
  });
  assert(
    abc.some((p) => p.includes('expected int') && p.includes('"abc"')),
    `abc: ${abc.join('\n')}`,
  );
});

Deno.test('missing leaf in defaults lists node path and env name', async () => {
  const dir = await writeTree({
    'defaults/communico.toml': `[server]
name = "localhost"
port = 8008

[db]
host = "127.0.0.1"
port = 5432
user = "root"
pass = "secret"
name = "postgres"

[media]
root = "./.media"
`,
  });
  const problems = loadFail({
    defaultsPath: `${dir}/defaults/communico.toml`,
    configPath: null,
    env: {},
  });
  assert(
    problems.some((p) =>
      p.includes('media.maxbytes') &&
      p.includes('COMMUNICO_MEDIA_MAXBYTES') &&
      p.includes('missing')
    ),
    `missing: ${problems.join('\n')}`,
  );
});

Deno.test('multiple problems reported together', async () => {
  const dir = await writeTree({
    'defaults/communico.toml': `[server]
name = "localhost"
port = "x"

[db]
host = "127.0.0.1"
port = 5432
user = "root"
pass = "secret"
name = "postgres"

[media]
root = "./.media"
`,
  });
  const problems = loadFail({
    defaultsPath: `${dir}/defaults/communico.toml`,
    configPath: null,
    env: {},
  });
  assert(
    problems.some((p) =>
      p.includes('media.maxbytes') && p.includes('COMMUNICO_MEDIA_MAXBYTES')
    ),
    `maxbytes: ${problems.join('\n')}`,
  );
  assert(
    problems.some((p) =>
      p.includes('server.port') && p.includes('COMMUNICO_SERVER_PORT') &&
      p.includes('expected int')
    ),
    `port: ${problems.join('\n')}`,
  );
  assert(
    problems.length >= 2,
    `wanted ≥2 problems, got ${problems.join('\n')}`,
  );
});

Deno.test('COMMUNICO_CONFIG selects an alternative overlay file', async () => {
  const dir = await writeTree({
    'defaults/communico.toml': FULL,
    'alt.toml': '[server]\nport = 8011\n',
  });
  const env = { COMMUNICO_CONFIG: `${dir}/alt.toml` };
  const paths = resolvePaths(dir, env);
  assertEquals(paths.configPath, `${dir}/alt.toml`);
  const loaded = loadConfig({
    defaultsPath: paths.defaultsPath,
    configPath: paths.configPath,
    env: {},
  });
  assertEquals(loaded.config.server.port, 8011);
  assertEquals(loaded.sources['server.port'], 'config');
});

Deno.test('absent config/communico.toml is fine', async () => {
  const dir = await writeTree({ 'defaults/communico.toml': FULL });
  const paths = resolvePaths(dir, {});
  assertEquals(paths.configPath, null);
  const loaded = loadConfig({
    defaultsPath: paths.defaultsPath,
    configPath: paths.configPath,
    env: {},
  });
  assertEquals(loaded.config.server.port, 8008);
});

Deno.test('--shell printer quoting', async () => {
  const dir = await writeTree({
    'defaults/communico.toml': FULL.replace(
      'pass = "secret"',
      'pass = "it\'s secret"',
    ),
  });
  const loaded = loadConfig({
    defaultsPath: `${dir}/defaults/communico.toml`,
    configPath: null,
    env: {},
  });
  const shell = formatShellExports(loaded.config);
  assert(
    shell.includes(`export COMMUNICO_DB_PASS='it'\\''s secret'`),
    `quoting: ${shell}`,
  );
  assert(
    shell.includes(`export COMMUNICO_SERVER_PORT='8008'`),
    `port: ${shell}`,
  );
});
