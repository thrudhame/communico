import { assertEquals } from '@std/assert';
import { DiagnosticCommand } from '#tests/helpers/child-diagnostics.ts';

Deno.test('gate collector preserves failed child stderr and exit cause before scratch cleanup', async () => {
  const output = await new DiagnosticCommand('python3', {
    args: [
      '-c',
      `
import importlib.util, pathlib, subprocess, tempfile, os
spec=importlib.util.spec_from_file_location('child_logs','tools/child_logs.py')
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as base:
 root=pathlib.Path(base); scratch=root/'scratch'; child=scratch/'child-logs-proof'; child.mkdir(parents=True)
 (child/'stderr.log').write_text('TypeError: gate-child-exception\\n    at child.ts:1:1\\n')
 (child/'status.json').write_text('{"success":false,"code":1,"signal":null}')
 def remote(command): return subprocess.check_output(command,shell=True)
 manifest=module.collect_child_logs(remote,str(scratch),root/'evidence','failed-gate')
 assert len(manifest)==2
 import shutil; shutil.rmtree(scratch)
 retained=root/'evidence'/'failed-gate-children'/'child-logs-proof'
 assert 'TypeError: gate-child-exception' in (retained/'stderr.log').read_text()
 assert '"code":1' in (retained/'status.json').read_text()
 print('failed child evidence retained after scratch removal')
`,
    ],
  }).output();
  assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
});
