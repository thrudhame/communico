import { adminRequest, cliArgs, runCli } from '#root/tools/admin-client.ts';
import type { reviewOutbox } from '#engine/federation/operator.ts';
type Review = Awaited<ReturnType<typeof reviewOutbox>>;

function usage(): never {
  console.error(
    'usage: deno task federation-outbox -- list [<destination>] | retry <destination> | prune <destination>',
  );
  Deno.exit(2);
}

function ago(ms: number | null): string {
  if (ms === null) return '-';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
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
                  ? `, unreachable since ${ago(s.unreachableSinceMs)}`
                  : '') +
                (s.nextAttemptMs > Date.now()
                  ? `, next attempt ${
                    ago(s.nextAttemptMs).replace(' ago', ' from now')
                  }`
                  : '') +
                (s.lastError ? `, last error: ${s.lastError}` : '')
              : ''),
        );
        for (const r of queued) {
          console.log(
            `  #${r.id} ${r.kind} ${
              r.eventId ?? JSON.stringify(r.intent)
            } added ${ago(r.addedMs)}, expires ${
              ago(r.expiresMs).replace(' ago', ' from now')
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
