import { resolve } from '@std/path';
import { adminRequest, cliArgs, runCli } from '#root/tools/admin-client.ts';

if (import.meta.main) {
  await runCli(async () => {
    const args = cliArgs();
    if (args.length !== 1 || args[0] === '' || args[0].startsWith('--')) {
      console.error('usage: deno task backup -- <destination>');
      Deno.exit(2);
    }
    // Resolve relative to the operator, not the running server's working dir.
    console.log(JSON.stringify(
      await adminRequest('backup', {
        destination: resolve(args[0]),
      }),
    ));
  });
}
