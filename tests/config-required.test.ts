// tests/config-required.test.ts — pins ruling 8 the same way
// env-precedence pins ruling 3: a missing variable is a startup error that
// lists EVERY missing name in one pass (never a silent default), and with
// all seven set the server binds APP_PORT and answers the Matrix surface.
import { assert, assertEquals } from '@std/assert';

const DENO = Deno.execPath();
const REQUIRED = [
  'APP_PORT',
  'SERVER_NAME',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASS',
  'DB_NAME',
];

const BASE_ENV: Record<string, string> = { PATH: Deno.env.get('PATH') ?? '/usr/bin' };

Deno.test('empty env → exit 1, stderr names all seven required variables', async () => {
  const emptyEnvFile = await Deno.makeTempDir() + '/empty.env';
  await Deno.writeTextFile(emptyEnvFile, '');
  // Deno auto-loads .env from cwd — the empty --env-file makes the
  // environment genuinely empty (env-file loses to the process env, which
  // carries nothing here).
  const cmd = new Deno.Command(DENO, {
    args: ['run', '--allow-env', '--allow-read', '--allow-net', 'main.ts'],
    cwd: new URL('..', import.meta.url).pathname,
    // clearEnv + no --env: the environment is genuinely empty (Deno.Command
    // otherwise MERGES env into the parent's, which carries the .env values
    // under the test task).
    clearEnv: true,
    env: BASE_ENV,
    stdout: 'piped',
    stderr: 'piped',
  });
  const out = await cmd.output();
  const stderr = new TextDecoder().decode(out.stderr);
  assertEquals(out.code, 1, `stderr: ${stderr}`);
  for (const name of REQUIRED) {
    assert(
      stderr.includes(`missing required environment variable ${name}`),
      `stderr missing ${name}: ${stderr}`,
    );
  }
});

Deno.test('all seven set → binds APP_PORT and answers GET /_matrix/client/versions', async () => {
  // Ephemeral-ish port: pick one, probe until the server answers.
  const port = 30000 + Math.floor(Math.random() * 20000);
  const cmd = new Deno.Command(DENO, {
    args: ['run', '--allow-env', '--allow-read', '--allow-net', 'main.ts'],
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...BASE_ENV,
      APP_PORT: String(port),
      SERVER_NAME: 'localhost',
      DB_HOST: '127.0.0.1',
      DB_PORT: '5432',
      DB_USER: 'root',
      DB_PASS: 'secret',
      DB_NAME: 'postgres',
    },
    stdout: 'piped',
    stderr: 'piped',
  });
  const child = cmd.spawn();
  try {
    const deadline = Date.now() + 15_000;
    let answered = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/_matrix/client/versions`);
        if (res.ok) {
          const body = await res.json();
          assert(Array.isArray(body.versions));
          answered = true;
          break;
        }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(answered, 'server did not answer /versions with all config set');
  } finally {
    child.kill('SIGTERM');
    await child.status;
  }
});