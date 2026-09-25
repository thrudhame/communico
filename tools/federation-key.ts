// tools/federation-key.ts — remembered server keys review surface.
// Exported functions (tests call these) + a thin CLI:
//   deno task federation-key -- list [<name>] | forget <name> | accept <name>
// `accept` installs the reviewed candidate document atomically and clears
// the block; `forget` deletes the server's remembered keys and documents
// so the next contact is first contact again.
import {
  acceptKeyChange,
  forgetServerKeys,
  listKeyChanges,
  listServerKeys,
} from '#engine/federation/keys.ts';

export { acceptKeyChange, forgetServerKeys, listKeyChanges, listServerKeys };

function usage(): never {
  console.error(
    'usage: deno task federation-key -- list [<name>] | forget <name> | accept <name>',
  );
  Deno.exit(2);
}

if (import.meta.main) {
  const argv = Deno.args[0] === '--' ? Deno.args.slice(1) : Deno.args;
  const [cmd, name] = argv;
  if (cmd === 'list') {
    const servers = await listServerKeys(name !== undefined ? name : null);
    for (const s of servers) {
      for (const row of s.rows) {
        const retired = row.expired_ts !== null
          ? ` retired(expired_ts=${row.expired_ts})`
          : '';
        const via = s.doc !== null ? s.doc.via : '?';
        console.log(
          `${row.key_id}  via=${via}  valid_until=${row.valid_until_ts}${retired}`,
        );
      }
    }
    if (name !== undefined) {
      const changes = await listKeyChanges(name);
      for (const ch of changes) {
        console.log(
          `change ${
            new Date(ch.seen_ms).toISOString()
          } status=${ch.status} acknowledged_old=${ch.acknowledged_old}`,
        );
      }
    }
  } else if (cmd === 'forget' && name !== undefined) {
    await forgetServerKeys(name);
    console.log(`forgot ${name} — next contact is first contact`);
  } else if (cmd === 'accept' && name !== undefined) {
    const ok = await acceptKeyChange(name);
    if (!ok) {
      console.error(`no blocking key change for ${name}`);
      Deno.exit(1);
    }
    console.log(`accepted the reviewed key document for ${name}`);
  } else {
    usage();
  }
}
