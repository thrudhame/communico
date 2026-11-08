// The error-path assertion from doltgres:tests/config-required.test.ts.
// Its complete-tree /versions startup case is also run as the per-commit
// main.ts smoke in CT 800 (isolated loopback namespace, workspace store).
import { assert, assertEquals } from '@std/assert';
import { dirname } from '@std/path';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

Deno.test('incomplete defaults → exit 1, stderr lists every problem', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'http-config-' });
  try {
    const path = `${dir}/defaults/communico.toml`;
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      '[server]\nname="localhost"\nport="x"\n[media]\nroot="./.media"\n',
    );
    const env: Record<string, string> = {};
    for (const name of ['PATH', 'TMPDIR', 'DENO_DIR']) {
      const value = Deno.env.get(name);
      if (value !== undefined) env[name] = value;
    }
    const out = await new Deno.Command(Deno.execPath(), {
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
      env,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
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
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
