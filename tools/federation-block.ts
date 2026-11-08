import { adminRequest, cliArgs, runCli } from '#root/tools/admin-client.ts';
import type { BlockRow } from '#engine/federation/peers.ts';

export const addBlock = (pattern: string, note: string | null) =>
  adminRequest('federation-block/add', { pattern, note });
export const removeBlock = (pattern: string) =>
  adminRequest<boolean>('federation-block/remove', { pattern });
export const listBlocks = () =>
  adminRequest<BlockRow[]>('federation-block/list');

function usage(): never {
  console.error(
    'usage: deno task federation-block -- add <glob> [--note <text>] | remove <glob> | list',
  );
  Deno.exit(2);
}

if (import.meta.main) {
  await runCli(async () => {
    const [cmd, ...rest] = cliArgs();
    if (cmd === 'add') {
      const pattern = rest[0];
      if (pattern === undefined) usage();
      const noteIdx = rest.indexOf('--note');
      const note = noteIdx >= 0 && rest[noteIdx + 1] !== undefined
        ? rest[noteIdx + 1]
        : null;
      await addBlock(pattern, note);
      console.log(`blocked ${pattern}`);
    } else if (cmd === 'remove') {
      const pattern = rest[0];
      if (pattern === undefined) usage();
      if (!await removeBlock(pattern)) {
        console.error(`${pattern} not blocked`);
        Deno.exit(1);
      }
      console.log(`unblocked ${pattern}`);
    } else if (cmd === 'list') {
      for (const b of await listBlocks()) {
        console.log(
          `${b.pattern}  ${new Date(b.added_ms).toISOString()}${
            b.note !== null ? `  note="${b.note}"` : ''
          }`,
        );
      }
    } else usage();
  });
}
