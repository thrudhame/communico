// tools/federation-block.ts — server-name glob blocks. Exported functions
// + a thin CLI:
//   add <glob> [--note <text>] | remove <glob> | list
import { addBlock, listBlocks, removeBlock } from '#engine/federation/peers.ts';

export { addBlock, listBlocks, removeBlock };

function usage(): never {
  console.error(
    'usage: deno task federation-block -- add <glob> [--note <text>] | remove <glob> | list',
  );
  Deno.exit(2);
}

if (import.meta.main) {
  const argv = Deno.args[0] === '--' ? Deno.args.slice(1) : Deno.args;
  const [cmd, ...rest] = argv;
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
    const ok = await removeBlock(pattern);
    if (!ok) {
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
  } else {
    usage();
  }
}
