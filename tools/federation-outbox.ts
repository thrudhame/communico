// tools/federation-outbox.ts — the delivery review surface (ruling E):
//   list [<destination>] | retry <destination> | prune <destination>
// `list` shows per destination: queued rows, in-flight txn, consecutive
// and lifetime failures, unreachable since, next attempt, last error —
// the "unreachable since …, N attempts" view of D2. Undelivered rows
// leave by exactly three doors: success, `prune` (operator), or the
// refusedmillihours expiry with its admin alert.
import {
  listOutbox,
  listPeerStatus,
  pruneDestination,
  retryDestination,
} from '#engine/federation/outbox.ts';
import { wakeDestination } from '#engine/federation/sender.ts';

function usage(): never {
  console.error(
    'usage: deno task federation-outbox -- list [<destination>] | retry <destination> | prune <destination>',
  );
  Deno.exit(2);
}

function ago(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const [cmd, arg] = Deno.args;

if (cmd === 'list') {
  const [rows, statuses] = await Promise.all([
    listOutbox(arg),
    listPeerStatus(),
  ]);
  const byDest = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byDest.get(r.destination) ?? [];
    list.push(r);
    byDest.set(r.destination, list);
  }
  const statusOf = new Map(statuses.map((s) => [s.destination, s]));
  const dests = [...new Set([...byDest.keys(), ...statusOf.keys()])].sort();
  if (dests.length === 0) {
    console.log('outbox empty');
  }
  for (const d of dests) {
    const s = statusOf.get(d);
    const queued = byDest.get(d) ?? [];
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
        `  #${r.id} ${r.kind} ${r.eventId ?? JSON.stringify(r.intent)} ` +
          `added ${ago(r.addedMs)}, expires ${
            ago(r.expiresMs).replace(' ago', ' from now')
          }` +
          (r.inflightTxn ? ` [${r.inflightTxn}]` : ''),
      );
    }
  }
} else if (cmd === 'retry' && arg !== undefined) {
  await retryDestination(arg);
  wakeDestination(arg);
  console.log(`retry queued for ${arg}`);
} else if (cmd === 'prune' && arg !== undefined) {
  const n = await pruneDestination(arg);
  console.log(`pruned ${n} row(s) for ${arg}`);
} else {
  usage();
}
