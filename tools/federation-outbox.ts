import { adminRequest, cliArgs, runCli } from '#root/tools/admin-client.ts';
import type { reviewOutbox } from '#engine/federation/operator.ts';
type Review = Awaited<ReturnType<typeof reviewOutbox>>;

function usage(): never {
  console.error(
    'usage: deno task federation-outbox -- list [<destination>] | retry <destination> | prune <destination>',
  );
  Deno.exit(2);
}

function relative(ms: number | null, now: number, expiry = false): string {
  if (ms === null) return '-';
  const s = Math.floor(Math.abs(now - ms) / 1000);
  const magnitude = s < 60
    ? `${s}s`
    : s < 3600
    ? `${Math.floor(s / 60)}m`
    : s < 86400
    ? `${Math.floor(s / 3600)}h`
    : `${Math.floor(s / 86400)}d`;
  if (expiry) {
    return ms > now ? `expires in ${magnitude}` : `expired ${magnitude} ago`;
  }
  return ms > now ? `in ${magnitude}` : `${magnitude} ago`;
}

if (import.meta.main) {
  await runCli(async () => {
    const [cmd, arg] = cliArgs();
    if (cmd === 'list') {
      const { rows, statuses } = await adminRequest<Review>(
        'federation-outbox/list',
        { destination: arg },
      );
      const byDest = new Map<string, typeof rows>();
      for (const row of rows) {
        const list = byDest.get(row.destination) ?? [];
        list.push(row);
        byDest.set(row.destination, list);
      }
      const statusOf = new Map(statuses.map((s) => [s.destination, s]));
      const dests = [...new Set([...byDest.keys(), ...statusOf.keys()])].sort();
      const now = Date.now();
      if (!dests.length) console.log('outbox empty');
      for (const d of dests) {
        const s = statusOf.get(d), queued = byDest.get(d) ?? [];
        const inflight = queued.find((r) => r.inflightTxn !== null);
        console.log(
          `${d}: ${queued.length} queued` +
            (inflight ? `, in-flight ${inflight.inflightTxn}` : '') +
            (s
              ? `, failures ${s.failures} (${s.failuresTotal} lifetime / ${s.attemptsTotal} attempts)` +
                (s.unreachableSinceMs !== null
                  ? `, unreachable since ${relative(s.unreachableSinceMs, now)}`
                  : '') +
                (s.nextAttemptMs > now
                  ? `, next attempt ${relative(s.nextAttemptMs, now)}`
                  : '') +
                (s.lastError ? `, last error: ${s.lastError}` : '')
              : ''),
        );
        for (const r of queued) {
          console.log(
            `  #${r.id} ${r.kind} ${
              r.eventId ?? JSON.stringify(r.intent)
            } added ${relative(r.addedMs, now)}, ${
              relative(r.expiresMs, now, true)
            }${r.inflightTxn ? ` [${r.inflightTxn}]` : ''}`,
          );
        }
      }
    } else if (cmd === 'retry' && arg !== undefined) {
      await adminRequest('federation-outbox/retry', { destination: arg });
      console.log(`retry queued for ${arg}`);
    } else if (cmd === 'prune' && arg !== undefined) {
      const n = await adminRequest<number>('federation-outbox/prune', {
        destination: arg,
      });
      console.log(`pruned ${n} row(s) for ${arg}`);
    } else usage();
  });
}
