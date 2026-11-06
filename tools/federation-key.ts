import { adminRequest, cliArgs, runCli } from '#root/tools/admin-client.ts';
import type { KeyChangeRow, KeyStore } from '#engine/federation/keys.ts';
type Keys = Awaited<ReturnType<KeyStore['listServerKeys']>>;
const review = (name: string | null) =>
  adminRequest<{ servers: Keys; changes: KeyChangeRow[] }>(
    'federation-key/list',
    { name },
  );
export const listServerKeys = async (name: string | null) =>
  (await review(name)).servers;
export const listKeyChanges = async (name: string) =>
  (await review(name)).changes;
export const forgetServerKeys = (name: string) =>
  adminRequest('federation-key/forget', { name });
export const acceptKeyChange = (name: string) =>
  adminRequest<boolean>('federation-key/accept', { name });

function usage(): never {
  console.error(
    'usage: deno task federation-key -- list [<name>] | forget <name> | accept <name>',
  );
  Deno.exit(2);
}

if (import.meta.main) {
  await runCli(async () => {
    const [cmd, name] = cliArgs();
    if (cmd === 'list') {
      const result = await review(name !== undefined ? name : null);
      for (const s of result.servers) {
        for (const row of s.rows) {
          const retired = row.expired_ts !== null
            ? ` retired(expired_ts=${row.expired_ts})`
            : '';
          console.log(
            `${row.key_id}  via=${
              s.doc !== null ? s.doc.via : '?'
            }  valid_until=${row.valid_until_ts}${retired}`,
          );
        }
      }
      for (const ch of result.changes) {
        console.log(
          `change ${
            new Date(ch.seen_ms).toISOString()
          } status=${ch.status} acknowledged_old=${ch.acknowledged_old}`,
        );
      }
    } else if (cmd === 'forget' && name !== undefined) {
      await forgetServerKeys(name);
      console.log(`forgot ${name} - next contact is first contact`);
    } else if (cmd === 'accept' && name !== undefined) {
      if (!await acceptKeyChange(name)) {
        console.error(`no blocking key change for ${name}`);
        Deno.exit(1);
      }
      console.log(`accepted the reviewed key document for ${name}`);
    } else usage();
  });
}
