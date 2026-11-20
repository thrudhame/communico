// Peeking owns its own wait loop. Observe its empty capture before acting;
// only this direct owner's clock and deadline are controlled.
import { latch, watchdog } from './ordering.ts';

function fromPeekingOwner(): boolean {
  const caller = new Error().stack?.split('\n').slice(1).find((frame) =>
    !frame.includes('/tests/support/peeking-turn.ts:')
  );
  return caller?.includes('/api/engine/client/peeking.ts:') === true;
}

export function observePeekingWait() {
  const now = Date.now;
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  let clock = now(), nextTimer = -1, captures = 0;
  let changed = latch();
  type Turn = { wake: () => void; captured: boolean };
  const timers = new Map<number, Turn>();
  const requests: { abort: AbortController; result: Promise<unknown> }[] = [];
  let latest: Turn | undefined;

  Date.now = () => {
    if (!fromPeekingOwner()) return now();
    // The first owner clock read after registration is the empty capture's
    // deadline check. A nonempty capture returns without this clock read.
    if (latest && !latest.captured) {
      latest.captured = true;
      captures++;
      const previous = changed;
      changed = latch();
      previous.release();
    }
    return clock;
  };
  globalThis.setTimeout = ((
    handler: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (!fromPeekingOwner()) return schedule(handler, delay, ...args);
    if (typeof handler !== 'function') throw new Error('expected peeking wake');
    const timer = nextTimer--;
    latest = { wake: () => handler(...args), captured: false };
    timers.set(timer, latest);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (timer) => {
    if (typeof timer !== 'number' || !timers.has(timer)) return cancel(timer);
    if (timers.get(timer) === latest) latest = undefined;
    timers.delete(timer);
  };

  return {
    start<T>(call: (signal: AbortSignal) => Promise<T>) {
      const baseline = captures;
      const abort = new AbortController();
      const result = call(abort.signal);
      void result.catch(() => undefined);
      requests.push({ abort, result });
      return {
        result,
        abort: () => abort.abort(),
        async capture() {
          while (captures <= baseline) {
            await watchdog(
              Promise.race([
                changed.wait,
                result.then(() => {
                  throw new Error('peeking returned before an empty capture');
                }),
              ]),
              'peeking completes an empty capture with its listener armed',
            );
          }
        },
        finish: () =>
          watchdog(result, 'peeking consumer finishes without its deadline'),
      };
    },
    elapse(ms: number) {
      clock += ms;
      for (const turn of timers.values()) turn.wake();
    },
    async close() {
      try {
        clock = Infinity;
        for (const turn of timers.values()) turn.wake();
        for (const request of requests) request.abort.abort();
        await watchdog(
          Promise.allSettled(requests.map((request) => request.result)),
          'owned peeking requests drain',
        );
      } finally {
        Date.now = now;
        globalThis.setTimeout = schedule;
        globalThis.clearTimeout = cancel;
      }
    },
  };
}
