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

[preview]
enabled = false
maxbytes = 10485760
blocklist = []
allowlist = []

[federation]
enabled = true
port = 8448
cert = "config/federation.crt"
key = "config/federation.key"
cacerts = []
keyvalidityhours = 168
keychange = "warn"
mode = "open"
wellknown = ""
wellknownmaxage = 86400
connectms = 5000
timeoutms = 30000
maxbytes = 1048576
wellknownhours = 24
wellknownmaxhours = 48
wellknownerrorhours = 1
keyfailminutes = 5
witnesses = 3
pendingmax = 10000
pendingdays = 30
lookups = "known"
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

Deno.test('[preview] enabled bool strictness; blocklist list; malformed CIDR', async () => {
  const dir = await writeTree({ 'defaults/communico.toml': FULL });
  const defaultsPath = `${dir}/defaults/communico.toml`;
  const enabled = loadConfig({
    defaultsPath,
    configPath: null,
    env: { COMMUNICO_PREVIEW_ENABLED: 'true' },
  });
  assertEquals(enabled.config.preview.enabled, true);
  assertEquals(enabled.sources['preview.enabled'], 'env');
  const badBool = loadFail({
    defaultsPath,
    configPath: null,
    env: { COMMUNICO_PREVIEW_ENABLED: 'TRUE' },
  });
  assert(
    badBool.some((p) =>
      p.includes('preview.enabled') &&
      p.includes('COMMUNICO_PREVIEW_ENABLED') &&
      p.includes('expected bool')
    ),
    `bool: ${badBool.join('\n')}`,
  );
  const listed = loadConfig({
    defaultsPath,
    configPath: null,
    env: { COMMUNICO_PREVIEW_BLOCKLIST: '127.0.0.0/8, 10.0.0.0/8' },
  });
  assertEquals(listed.config.preview.blocklist, [
    '127.0.0.0/8',
    '10.0.0.0/8',
  ]);
  const overlayDir = await writeTree({
    'defaults/communico.toml': FULL,
    'config/communico.toml': '[preview]\nblocklist = ["not-a-cidr"]\n',
  });
  const malformed = loadFail({
    defaultsPath: `${overlayDir}/defaults/communico.toml`,
    configPath: `${overlayDir}/config/communico.toml`,
    env: {},
  });
  assert(
    malformed.some((p) =>
      p.includes('preview.blocklist') &&
      p.includes('COMMUNICO_PREVIEW_BLOCKLIST') &&
      p.includes('malformed CIDR') &&
      p.includes('not-a-cidr')
    ),
    `cidr: ${malformed.join('\n')}`,
  );
  const empty = loadConfig({
    defaultsPath,
    configPath: null,
    env: {},
  });
  assertEquals(empty.config.preview.blocklist, []);
  assertEquals(empty.config.preview.allowlist, []);
  assertEquals(empty.config.preview.enabled, false);
  assertEquals(empty.config.preview.maxbytes, 10485760);
});

Deno.test('[federation] 21 leaves, env names, enum/cap validation', async () => {
  const dir = await writeTree({ 'defaults/communico.toml': FULL });
  const defaultsPath = `${dir}/defaults/communico.toml`;
  const loaded = loadConfig({ defaultsPath, configPath: null, env: {} });
  const f = loaded.config.federation;
  assertEquals(f.enabled, true);
  assertEquals(f.port, 8448);
  assertEquals(f.cert, 'config/federation.crt');
  assertEquals(f.key, 'config/federation.key');
  assertEquals(f.cacerts, []);
  assertEquals(f.keyvalidityhours, 168);
  assertEquals(f.keychange, 'warn');
  assertEquals(f.mode, 'open');
  assertEquals(f.wellknown, '');
  assertEquals(f.wellknownmaxage, 86400);
  assertEquals(f.connectms, 5000);
  assertEquals(f.timeoutms, 30000);
  assertEquals(f.maxbytes, 1048576);
  assertEquals(f.wellknownhours, 24);
  assertEquals(f.wellknownmaxhours, 48);
  assertEquals(f.wellknownerrorhours, 1);
  assertEquals(f.keyfailminutes, 5);
  assertEquals(f.witnesses, 3);
  assertEquals(f.pendingmax, 10000);
  assertEquals(f.pendingdays, 30);
  assertEquals(f.lookups, 'known');

  const fromEnv = loadConfig({
    defaultsPath,
    configPath: null,
    env: {
      COMMUNICO_FEDERATION_MODE: 'closed',
      COMMUNICO_FEDERATION_KEYCHANGE: 'block',
      COMMUNICO_FEDERATION_LOOKUPS: 'none',
      COMMUNICO_FEDERATION_WITNESSES: '5',
    },
  });
  assertEquals(fromEnv.config.federation.mode, 'closed');
  assertEquals(fromEnv.config.federation.keychange, 'block');
  assertEquals(fromEnv.config.federation.lookups, 'none');
  assertEquals(fromEnv.config.federation.witnesses, 5);
  assertEquals(fromEnv.sources['federation.mode'], 'env');

  const badKeychange = loadFail({
    defaultsPath,
    configPath: null,
    env: { COMMUNICO_FEDERATION_KEYCHANGE: 'yolo' },
  });
  assert(
    badKeychange.some((p) =>
      p.includes('federation.keychange') &&
      p.includes('COMMUNICO_FEDERATION_KEYCHANGE') &&
      p.includes('accept, warn, block')
    ),
    `keychange: ${badKeychange.join('\n')}`,
  );
  const badMode = loadFail({
    defaultsPath,
    configPath: null,
    env: { COMMUNICO_FEDERATION_MODE: 'half-open' },
  });
  assert(
    badMode.some((p) =>
      p.includes('federation.mode') && p.includes('open, closed')
    ),
    `mode: ${badMode.join('\n')}`,
  );
  const badLookups = loadFail({
    defaultsPath,
    configPath: null,
    env: { COMMUNICO_FEDERATION_LOOKUPS: 'proxy' },
  });
  assert(
    badLookups.some((p) =>
      p.includes('federation.lookups') && p.includes('known, none')
    ),
    `lookups: ${badLookups.join('\n')}`,
  );
  const overCap = loadFail({
    defaultsPath,
    configPath: null,
    env: { COMMUNICO_FEDERATION_KEYVALIDITYHOURS: '169' },
  });
  assert(
    overCap.some((p) =>
      p.includes('federation.keyvalidityhours') && p.includes('168')
    ),
    `cap: ${overCap.join('\n')}`,
  );
  const noWitnesses = loadFail({
    defaultsPath,
    configPath: null,
    env: { COMMUNICO_FEDERATION_WITNESSES: '0' },
  });
  assert(
    noWitnesses.some((p) =>
      p.includes('federation.witnesses') && p.includes('>= 1')
    ),
    `witnesses: ${noWitnesses.join('\n')}`,
  );
});

Deno.test('[federation] cacerts must be readable files', async () => {
  const caFile = await Deno.makeTempFile();
  const dir = await writeTree({ 'defaults/communico.toml': FULL });
  const defaultsPath = `${dir}/defaults/communico.toml`;
  const ok = loadConfig({
    defaultsPath,
    configPath: null,
    env: { COMMUNICO_FEDERATION_CACERTS: caFile },
  });
  assertEquals(ok.config.federation.cacerts, [caFile]);
  const missing = loadFail({
    defaultsPath,
    configPath: null,
    env: { COMMUNICO_FEDERATION_CACERTS: `${dir}/no-such-ca.crt` },
  });
  assert(
    missing.some((p) =>
      p.includes('federation.cacerts') &&
      p.includes('COMMUNICO_FEDERATION_CACERTS') &&
      p.includes('not readable')
    ),
    `cacerts: ${missing.join('\n')}`,
  );
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
