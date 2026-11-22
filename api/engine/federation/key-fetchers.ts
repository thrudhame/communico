// Each store's witness and direct fetcher owns one batch at a time. Like
// Synapse's KeyFetcher/BatchingQueue, arrivals during a fetch form the next
// batch; there is no numeric admission limit or dropped demand.
import { demandedWork, joinDemand, settleAll } from '#engine/net/demand.ts';
import type { KeysDeps } from './keys.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';

type Answer = { value: unknown } | { error: unknown };
type Demands = Parameters<KeysDeps['witnessQuery']>[1];

async function witnessAnswers(
  deps: KeysDeps,
  peer: string,
  demands: Demands,
  signal: AbortSignal,
): Promise<Map<string, Answer>> {
  const names = Object.keys(demands);
  try {
    signal.throwIfAborted();
    const value = await deps.witnessQuery(peer, demands, signal);
    return new Map(names.map((name) => [name, { value }]));
  } catch (error) {
    if (
      names.length > 1 && error instanceof UpstreamError &&
      error.context.resourceLimit &&
      ['http-body', 'http-representation'].includes(error.context.phase)
    ) {
      // The existing per-response limit is not a limit on the number of
      // requested origins. Retry smaller answers, serially within this batch.
      const middle = Math.ceil(names.length / 2);
      const answers = new Map<string, Answer>();
      for (const part of [names.slice(0, middle), names.slice(middle)]) {
        const result = await witnessAnswers(
          deps,
          peer,
          Object.fromEntries(part.map((name) => [name, demands[name]])),
          signal,
        );
        for (const [name, answer] of result) answers.set(name, answer);
      }
      return answers;
    }
    // A single origin's oversized answer remains a failure for that origin,
    // without erasing usable answers from the other half of a split batch.
    return new Map(names.map((name) => [name, { error }]));
  }
}

type Fetch = {
  name: string;
  horizon: number;
  deps: KeysDeps;
  peer?: string;
  keyId?: string;
};
type Pending = {
  value: Fetch;
  signal?: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

function fetcher(witness: boolean) {
  let pending: Pending[] = [];
  let running = false;

  async function drain(): Promise<void> {
    let batch: Pending[] = [];
    try {
      while (pending.length > 0) {
        // Defer a turn so adjacent demands can enter the same batch.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        batch = pending;
        pending = [];
        const groups = new Map<string, Pending[]>();
        for (const item of batch) {
          if (item.signal?.aborted) {
            item.reject(item.signal.reason);
            continue;
          }
          const key = witness ? item.value.peer! : item.value.name;
          let group = groups.get(key);
          if (group === undefined) groups.set(key, group = []);
          group.push(item);
        }
        await settleAll(Array.from(groups, async ([key, group]) => {
          const demands: Record<string, number> = Object.create(null);
          for (const { value } of group) {
            const old = demands[value.name];
            demands[value.name] = old === undefined
              ? value.horizon
              : Math.max(old, value.horizon);
          }
          const deps = group[0].value.deps;
          const serverKeys: Record<
            string,
            Record<string, { minimum_valid_until_ts: number }>
          > = Object.create(null);
          for (const { value } of group) {
            let keys = serverKeys[value.name];
            if (keys === undefined) serverKeys[value.name] = keys = {};
            if (value.keyId !== undefined) {
              keys[value.keyId] = {
                minimum_valid_until_ts: demands[value.name],
              };
            }
          }
          const work = demandedWork(async (signal) =>
            witness
              ? await witnessAnswers(deps, key, serverKeys, signal)
              : new Map<string, Answer>([[key, {
                value: await deps.directGet(key, demands[key], signal),
              }]])
          );
          // One cancelled origin cannot abort a shared notary POST. The last
          // live origin owns cancellation, and the batch retains callback drain.
          await Promise.all(group.map(async (item) => {
            try {
              const answers = await joinDemand(work, item.signal);
              const answer = answers.get(item.value.name);
              if (!answer) {
                throw new Error('key fetcher omitted a demanded origin');
              }
              if ('error' in answer) throw answer.error;
              item.resolve(answer.value);
            } catch (error) {
              item.reject(error);
            }
          }));
        }));
        batch = [];
      }
    } catch (error) {
      // Retain sibling callback drain above, then settle both the active and
      // queued callers even if local batch preparation itself fails.
      for (const item of [...batch, ...pending]) item.reject(error);
      pending = [];
    } finally {
      running = false;
    }
  }

  return (value: Fetch, signal?: AbortSignal): Promise<unknown> => {
    signal?.throwIfAborted();
    const result = new Promise((resolve, reject) => {
      pending.push({ value, signal, resolve, reject });
    });
    if (!running) {
      running = true;
      void drain();
    }
    return result;
  };
}

export function keyFetchers() {
  return { witness: fetcher(true), direct: fetcher(false) };
}
