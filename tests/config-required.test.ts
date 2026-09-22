// tests/config-required.test.ts — a defaults file missing a leaf and
// mistyped on another lists EVERY problem in one pass (never a silent
// default); with a complete tree the server binds COMMUNICO_SERVER_PORT
// and answers the Matrix surface.
import { assert, assertEquals } from '@std/assert';
import { dirname } from '@std/path';

const DENO = Deno.execPath();
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const pathEnv = Deno.env.get('PATH');
if (pathEnv === undefined) throw new Error('PATH is required to spawn deno');
const BASE_ENV: Record<string, string> = { PATH: pathEnv };

async function writeTree(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir();
  for (const [rel, body] of Object.entries(files)) {
    const path = `${dir}/${rel}`;
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, body);
  }
  return dir;
}

Deno.test('incomplete defaults → exit 1, stderr lists every problem', async () => {
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
  const cmd = new Deno.Command(DENO, {
    args: [
      'run',
      `--config=${REPO}/deno.json`,
      '--allow-env',
      '--allow-read',
      '--allow-net',
      `${REPO}/main.ts`,
    ],
    cwd: dir,
    clearEnv: true,
    env: BASE_ENV,
    stdout: 'piped',
    stderr: 'piped',
  });
  const out = await cmd.output();
  const stderr = new TextDecoder().decode(out.stderr);
  assertEquals(out.code, 1, `stderr: ${stderr}`);
  assert(
    stderr.includes('media.maxbytes') &&
      stderr.includes('COMMUNICO_MEDIA_MAXBYTES'),
    `stderr missing media.maxbytes: ${stderr}`,
  );
  assert(
    stderr.includes('server.port') &&
      stderr.includes('COMMUNICO_SERVER_PORT') &&
      stderr.includes('expected int'),
    `stderr missing server.port: ${stderr}`,
  );
});

Deno.test('complete tree → binds COMMUNICO_SERVER_PORT and answers GET /_matrix/client/versions', async () => {
  let port = 0;
  for (let i = 0; i < 5 && port === 0; i++) {
    const candidate = 30000 + Math.floor(Math.random() * 20000);
    let listener: Deno.Listener | null = null;
    try {
      listener = Deno.listen({ port: candidate });
      port = candidate;
    } catch { /* in use — try another */ }
    listener?.close();
  }
  assert(port > 0, 'no free port found');
  const mediaRoot = await Deno.makeTempDir();
  const cmd = new Deno.Command(DENO, {
    args: [
      'run',
      '--allow-env',
      '--allow-read',
      '--allow-net',
      '--allow-write',
      'main.ts',
    ],
    cwd: REPO,
    env: {
      ...BASE_ENV,
      COMMUNICO_SERVER_PORT: String(port),
      COMMUNICO_MEDIA_ROOT: mediaRoot,
    },
    stdout: 'piped',
    stderr: 'piped',
  });
  const child = cmd.spawn();
  let exited: { code: number } | null = null;
  const exitedP = child.status.then((st: { code: number }) => {
    exited = st;
  });
  try {
    const deadline = Date.now() + 15_000;
    let answered = false;
    while (Date.now() < deadline) {
      await Promise.race([new Promise((r) => setTimeout(r, 250)), exitedP]);
      if (exited !== null) break;
      try {
        const res = await fetch(
          `http://127.0.0.1:${port}/_matrix/client/versions`,
        );
        if (res.ok) {
          const body = await res.json();
          assert(Array.isArray(body.versions));
          answered = true;
          break;
        }
      } catch { /* not up yet */ }
    }
    assert(
      exited === null,
      `server exited early (code ${
        (exited as unknown as { code: number })?.code
      })`,
    );
    assert(answered, 'server did not answer /versions with complete config');
  } finally {
    try {
      child.kill('SIGTERM');
    } catch { /* already gone */ }
    await child.status;
  }
});
