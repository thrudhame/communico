// tests/env-precedence.test.ts — Deno's env > .env pin (ruling 3) plus
// config merge order via a main.ts-like probe: defaults < config < env.
// Deno flip-flopped on env vs .env across releases (2.6.10 env-wins →
// 2.7.0/1 file-wins → 2.7.2 env-wins; denoland/deno#31712, #32392, #32407).
// Pure: subprocess probes, no DB, no server.
import { dirname } from '@std/path';

const DENO = Deno.execPath();
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
function requirePath(): string {
  const p = Deno.env.get('PATH');
  if (p === undefined) throw new Error('PATH is required to spawn deno');
  return p;
}
const pathEnv = requirePath();

const PROBE = `console.log('VALUE=' + Deno.env.get('TEST_KEY'));\n`;

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

const CONFIG_PROBE =
  `import { loadConfig, resolvePaths } from '#engine/config.ts';
const env = Deno.env.toObject();
const { defaultsPath, configPath } = resolvePaths(Deno.cwd(), env);
const { config } = loadConfig({ defaultsPath, configPath, env });
console.log('PORT=' + config.server.port);
`;

async function makeDir(envContent: string | null): Promise<string> {
  const dir = await Deno.makeTempDir();
  if (envContent !== null) {
    await Deno.writeTextFile(`${dir}/.env`, envContent);
  }
  await Deno.writeTextFile(`${dir}/probe.ts`, PROBE);
  return dir;
}

async function runProbe(
  dir: string,
  envFlag: string | null,
  extraEnv: Record<string, string>,
): Promise<{ stdout: string; code: number }> {
  const args = ['run', '--allow-env'];
  if (envFlag !== null) {
    args.push(envFlag === '' ? '--env' : envFlag);
  }
  args.push('probe.ts');
  const cmd = new Deno.Command(DENO, {
    args,
    cwd: dir,
    env: { PATH: pathEnv, ...extraEnv },
    stdout: 'piped',
    stderr: 'piped',
  });
  const out = await cmd.output();
  return {
    stdout: new TextDecoder().decode(out.stdout),
    code: out.code,
  };
}

function assertValue(res: { stdout: string; code: number }, expected: string) {
  if (!res.stdout.includes(`VALUE=${expected}`)) {
    throw new Error(
      `env precedence broke on Deno ${Deno.version.deno}: wanted VALUE=${expected}, got ${
        JSON.stringify(res.stdout)
      }`,
    );
  }
}

async function writeTree(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir();
  for (const [rel, body] of Object.entries(files)) {
    const path = `${dir}/${rel}`;
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, body);
  }
  return dir;
}

async function runConfigProbe(
  dir: string,
  extraEnv: Record<string, string>,
): Promise<{ stdout: string; code: number; stderr: string }> {
  await Deno.writeTextFile(`${dir}/probe-config.ts`, CONFIG_PROBE);
  const cmd = new Deno.Command(DENO, {
    args: [
      'run',
      `--config=${REPO}/deno.json`,
      '--allow-env',
      '--allow-read',
      `${dir}/probe-config.ts`,
    ],
    cwd: dir,
    env: { PATH: pathEnv, ...extraEnv },
    stdout: 'piped',
    stderr: 'piped',
  });
  const out = await cmd.output();
  return {
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
    code: out.code,
  };
}

Deno.test('.env only → file value', async () => {
  const dir = await makeDir('TEST_KEY=file-value\n');
  const res = await runProbe(dir, '', {});
  assertValue(res, 'file-value');
});

Deno.test('env + .env → env wins', async () => {
  const dir = await makeDir('TEST_KEY=file-value\n');
  const res = await runProbe(dir, '', { TEST_KEY: 'env-value' });
  assertValue(res, 'env-value');
});

Deno.test('env, no file → env', async () => {
  const dir = await makeDir(null);
  const res = await runProbe(dir, null, { TEST_KEY: 'env-value' });
  assertValue(res, 'env-value');
});

Deno.test('--env-file=<explicit> + env → env wins', async () => {
  const dir = await makeDir(null);
  await Deno.writeTextFile(`${dir}/custom.env`, 'TEST_KEY=file-value\n');
  const res = await runProbe(
    dir,
    `--env-file=${dir}/custom.env`,
    { TEST_KEY: 'env-value' },
  );
  assertValue(res, 'env-value');
});

Deno.test('config overlay wins over defaults; env wins over config', async () => {
  const dir = await writeTree({
    'defaults/communico.toml': FULL,
    'config/communico.toml': '[server]\nport = 8009\n',
  });
  const overDefaults = await runConfigProbe(dir, {});
  if (overDefaults.code !== 0 || !overDefaults.stdout.includes('PORT=8009')) {
    throw new Error(
      `config over defaults: code=${overDefaults.code} stdout=${
        JSON.stringify(overDefaults.stdout)
      } stderr=${JSON.stringify(overDefaults.stderr)}`,
    );
  }
  const overConfig = await runConfigProbe(dir, {
    COMMUNICO_SERVER_PORT: '8010',
  });
  if (overConfig.code !== 0 || !overConfig.stdout.includes('PORT=8010')) {
    throw new Error(
      `env over config: code=${overConfig.code} stdout=${
        JSON.stringify(overConfig.stdout)
      } stderr=${JSON.stringify(overConfig.stderr)}`,
    );
  }
});
