// tests/env-precedence.test.ts — pins Deno's env > .env precedence (ruling 3).
// Deno flip-flopped on this across releases (2.6.10 env-wins → 2.7.0/1
// file-wins → 2.7.2 env-wins; denoland/deno#31712, #32392, #32407), so a
// test pins the contract: the real environment wins over .env, .env fills
// the gaps, and an explicit --env-file loses to the environment too.
// Pure: subprocess probes, no DB, no server.
const DENO = Deno.execPath();

const PROBE = `console.log('VALUE=' + Deno.env.get('TEST_KEY'));\n`;

/** Write a temp dir; `envContent` (null = no .env); returns dir. */
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
  envFlag: string | null, // null → no flag; '' → --env; else the full flag
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
    env: { PATH: Deno.env.get('PATH') ?? '/usr/bin', ...extraEnv },
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
