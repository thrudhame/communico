import { restoreBackup } from '#engine/backup/restore.ts';
import { cliArgs, runCli } from '#root/tools/admin-client.ts';

if (import.meta.main) {
  await runCli(async () => {
    const args = cliArgs();
    const replace = args.includes('--replace');
    const paths = args.filter((arg) => arg !== '--replace');
    if (
      paths.length !== 1 || paths[0] === '' || paths[0].startsWith('--') ||
      args.length !== (replace ? 2 : 1)
    ) {
      console.error('usage: deno task restore -- <bundle> [--replace]');
      Deno.exit(2);
    }
    const result = await restoreBackup(paths[0], { replace });
    // The detailed security/RPO inventory remains in the durable report.
    const { report: _report, ...summary } = result;
    console.log(JSON.stringify(summary));
  });
}
