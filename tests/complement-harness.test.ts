import { assertEquals } from '@std/assert';

Deno.test('Complement harness records the canonical executed settings vector', async () => {
  const dir = await Deno.makeTempDir();
  const realDeno = Deno.execPath();
  try {
    await Deno.mkdir(`${dir}/complement`, { recursive: true });
    await Deno.mkdir(`${dir}/.native`);
    await Deno.mkdir(`${dir}/bin`);
    await Deno.mkdir(`${dir}/upstream`);
    await Deno.writeTextFile(`${dir}/main.ts`, '');
    await Deno.writeTextFile(`${dir}/.native/libturso_ffi.so`, 'fixture');
    for (const name of ['Dockerfile', 'entrypoint.sh', 'blacklist.md']) {
      await Deno.writeTextFile(`${dir}/complement/${name}`, '');
    }
    await Deno.copyFile(
      new URL('../complement/run.sh', import.meta.url),
      `${dir}/complement/run.sh`,
    );
    await Deno.writeTextFile(
      `${dir}/complement/settings.tsv`,
      'TestConfigured\tPASS_COMMUNICO_ONE=true   \t PASS_COMMUNICO_TWO=false  \n',
    );
    const scripts = {
      git:
        `#!/bin/bash\ncase "$*" in\n*--short*) echo 1234567;;\n*--git-dir*) echo .git;;\n*rev-parse*) echo fixture-commit;;\n*archive*) tar -cf - --files-from /dev/null;;\n*status*) :;;\nesac\n`,
      docker:
        '#!/bin/bash\nif [[ "$1" = network ]]; then echo 172.17.0.0/16; fi\n',
      deno:
        `#!/bin/bash\nif [[ "$1" = task ]]; then exit 0; fi\nexec '${realDeno}' "$@"\n`,
      go:
        '#!/bin/bash\nif [[ " $* " = *" -list "* ]]; then echo TestConfigured; else if [[ "${PASS_COMMUNICO_ONE:-}" = true ]]; then printf \'{"Action":"pass","Package":"fixture","Test":"TestConfigured"}\\n\'; fi; printf \'{"Action":"pass","Package":"fixture"}\\n\'; fi\n',
    };
    for (const [name, text] of Object.entries(scripts)) {
      await Deno.writeTextFile(`${dir}/bin/${name}`, text);
      await Deno.chmod(`${dir}/bin/${name}`, 0o755);
    }
    const out = await new Deno.Command('bash', {
      args: ['complement/run.sh'],
      cwd: dir,
      env: {
        PATH: `${dir}/bin:${Deno.env.get('PATH')}`,
        COMPLEMENT_SRC: `${dir}/upstream`,
      },
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
    const runs = await Deno.readTextFile(
      `${dir}/complement/work-1234567/runs.tsv`,
    );
    assertEquals(
      runs.split('\n')[1].split('\t')[2],
      'PASS_COMMUNICO_ONE=true PASS_COMMUNICO_TWO=false',
    );
    const baseline = await Deno.readTextFile(`${dir}/complement/BASELINE.md`);
    assertEquals(
      baseline.includes('| PASS_COMMUNICO_ONE=true PASS_COMMUNICO_TWO=false |'),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
