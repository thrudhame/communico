import { DiagnosticCommand } from '#tests/helpers/child-diagnostics.ts';
import { assert } from '@std/assert';
import { join } from '@std/path';

for (const kind of ['early', 'main', 'peak']) {
  Deno.test(`owned checkpoint capacity: ${kind}`, async () => {
    const directory = await Deno.makeTempDir({
      prefix: 'checkpoint-capacity-',
    });
    const database = join(directory, 'data.db');
    const preload = join(directory, 'enospc.so');
    const arm = join(directory, 'arm');
    const operation = kind === 'early' ? 'pwritev' : 'pwrite';
    const target = kind === 'early' ? database + '-wal' : database;
    const env: Record<string, string> = {};
    const decoder = new TextDecoder();
    try {
      if (kind !== 'peak') {
        const compiler = await new DiagnosticCommand('cc', {
          args: [
            '-shared',
            '-fPIC',
            '-o',
            preload,
            'tests/fixtures/checkpoint-enospc.c',
            '-ldl',
          ],
        }).output();
        assert(compiler.success, decoder.decode(compiler.stderr));
        Object.assign(env, {
          LD_PRELOAD: preload,
          CHECKPOINT_FAULT_PATH: target,
          CHECKPOINT_FAULT_OPERATION: operation,
          CHECKPOINT_FAULT_ARM: arm,
        });
      }
      const run = await new DiagnosticCommand(Deno.execPath(), {
        args: [
          'run',
          '--allow-read',
          '--allow-write',
          '--allow-env',
          '--allow-ffi',
          '--allow-sys=statfs',
          'tests/fixtures/checkpoint-capacity.ts',
          directory,
          kind,
        ],
        env,
      }).output();
      const diagnostics = decoder.decode(run.stderr);
      assert(run.success, diagnostics);
      if (kind !== 'peak') {
        assert(
          diagnostics.includes(`injected ENOSPC: ${operation} ${target}\n`),
        );
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
}
