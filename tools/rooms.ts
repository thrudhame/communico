import { adminRequest, cliArgs, runCli } from '#root/tools/admin-client.ts';
import type { OperatorRoom } from '#engine/room/operator.ts';

function usage(): never {
  console.error(
    'usage: deno task rooms -- list [--purgeable] | purge [--older-than <ms>] | drop <roomId>',
  );
  Deno.exit(2);
}

if (import.meta.main) {
  await runCli(async () => {
    const [cmd, ...rest] = cliArgs();
    if (cmd === 'list') {
      const purgeable = rest.includes('--purgeable');
      const rows = await adminRequest<OperatorRoom[]>('rooms/list', {
        purgeable,
      });
      if (!rows.length) {
        console.log(purgeable ? 'no rooms offered for purge' : 'no rooms');
      }
      for (const r of rows) {
        console.log(
          `${r.room_id} (v${r.room_version}) ${
            r.current_stay === null ? 'archived' : `stay ${r.current_stay}`
          }${
            r.purgeable_ms !== null
              ? ` - purgeable since ${new Date(r.purgeable_ms).toISOString()}`
              : ''
          }`,
        );
      }
    } else if (cmd === 'purge') {
      const idx = rest.indexOf('--older-than');
      const olderThan = idx >= 0 ? Number(rest[idx + 1]) : null;
      if (idx >= 0 && !Number.isFinite(olderThan)) usage();
      const rows = await adminRequest<{ room_id: string; settled: number }[]>(
        'rooms/purge',
        { olderThan },
      );
      if (!rows.length) console.log('no rooms offered for purge');
      for (const r of rows) {
        console.log(
          `purged ${r.room_id} (database dropped, ${r.settled} outbox row(s) settled)`,
        );
      }
    } else if (cmd === 'drop' && rest.length === 1) {
      const r = await adminRequest<{ room_id: string; settled: number }>(
        'rooms/drop',
        { roomId: rest[0] },
      );
      console.log(
        `dropped ${r.room_id} (database dropped, ${r.settled} outbox row(s) settled)`,
      );
    } else usage();
  });
}
