// Shared work owns cancellation, rather than its first caller. Joining callers
// retain ownership until the real callback settles, even after losing demand.
export type DemandedWork<T> = {
  run: Promise<T>;
  abort: AbortController;
  subscribers: number;
};

export function demandedWork<T>(
  run: (signal: AbortSignal) => Promise<T>,
): DemandedWork<T> {
  const abort = new AbortController();
  return { abort, run: run(abort.signal), subscribers: 0 };
}

export async function joinDemand<T>(
  work: DemandedWork<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  work.subscribers++;
  let subscribed = true;
  const release = () => {
    if (!subscribed) return;
    subscribed = false;
    if (--work.subscribers === 0) work.abort.abort();
  };
  signal?.addEventListener('abort', release, { once: true });
  try {
    const result = await work.run;
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener('abort', release);
    release();
  }
}

// Promise.all rejects before sibling callbacks settle. An owning operation
// must retain those callbacks (and their storage capabilities) even on failure.
export async function settleAll<T>(runs: readonly Promise<T>[]): Promise<T[]> {
  const outcomes = await Promise.allSettled(runs);
  return outcomes.map((outcome) => {
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  });
}
