// One retrieval strategy for state/auth boundaries. A dense missing set uses
// /state (as Synapse does); sparse or unavailable/incomplete bulk answers use
// bounded /event reads. The caller still owns whole-boundary authorization and
// publication. Nothing returned here is accepted merely because a peer named it.
import type { Pdu } from '#engine/pdu.ts';
import type { Fetcher, KeyResolver } from './deps.ts';
import { identify, verify } from './verify.ts';

export async function fetchBoundaryEvents(
  unknown: readonly string[],
  wantedCount: number,
  opts: {
    roomId: string;
    at: string;
    via: string;
    version: string;
    fetcher: Fetcher;
    keys: KeyResolver;
    signal?: AbortSignal;
    concurrency: number;
    active: () => boolean;
    read: <T>(op: () => Promise<T | null>) => Promise<T | null>;
    work?: () => boolean;
    canReadAll?: (count: number) => boolean;
    exemptPrevAuthLimits?: boolean;
  },
): Promise<Map<string, Pdu> | null> {
  const pack = new Map<string, Pdu>();
  if (unknown.length === 0) return pack;
  const wanted = new Set(unknown);
  const verification = {
    roomId: opts.roomId,
    exemptPrevAuthLimits: opts.exemptPrevAuthLimits === true,
  };
  // Use recomputed IDs even when a response has an event_id annotation. Held,
  // duplicate and unrequested events cannot consume signature work or enter the
  // evidence pack. A failed candidate never prevents a later valid copy.
  const admit = async (raw: Pdu, expected?: string): Promise<void> => {
    if (!opts.active() || (opts.work !== undefined && !opts.work())) return;
    try {
      const id = (await identify(raw, opts.version, verification)).eventId;
      if (
        !wanted.has(id) || pack.has(id) ||
        (expected !== undefined && id !== expected)
      ) return;
      const verified = await verify(raw, opts.version, opts.keys, verification);
      pack.set(id, verified.pdu);
    } catch {
      // Verification failure is missing evidence, never an accepted prefix.
    }
  };
  if (unknown.length * 10 >= wantedCount && opts.active()) {
    const snapshot = await opts.read(() =>
      opts.fetcher.state(opts.roomId, opts.at, opts.via, opts.signal)
    );
    if (snapshot !== null) {
      for (const raw of [...snapshot.authChain, ...snapshot.state]) {
        if (!opts.active()) return null;
        await admit(raw);
      }
    }
  }
  const remaining = unknown.filter((id) => !pack.has(id));
  // An impossible boundary must not consume the allowance needed by a later
  // independent boundary. Bulk may have made this set small enough to fit.
  if (opts.canReadAll !== undefined && !opts.canReadAll(remaining.length)) {
    return null;
  }
  for (let start = 0; start < remaining.length; start += opts.concurrency) {
    if (!opts.active()) return null;
    const wave = remaining.slice(start, start + opts.concurrency);
    await Promise.all(wave.map(async (id) => {
      const raw = await opts.read(() =>
        opts.fetcher.event(id, opts.via, opts.roomId, opts.signal)
      );
      if (raw !== null) await admit(raw, id);
    }));
  }
  return opts.active()
    ? new Map(
      unknown.filter((id) => pack.has(id)).map((id) => [id, pack.get(id)!]),
    )
    : null;
}
