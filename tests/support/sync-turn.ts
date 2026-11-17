// Observe the actual stream-wait capture, not the HTTP client's async context.
// Polling is withheld; negative checks explicitly drive the registered wake.
import { latch, watchdog } from './ordering.ts';

type Turn = {
  wake: () => void;
  capture: ReturnType<typeof latch>;
  relevant?: boolean;
};

// Nested database/rendering frames do not count as direct owner calls.
function fromWaitOwner(): boolean {
  const caller = new Error().stack?.split('\n').slice(1).find((frame) =>
    !frame.includes('/tests/support/sync-turn.ts:')
  );
  return caller?.includes('/api/engine/sync-wait.ts:') === true;
}

export function observeSyncWait() {
  const now = Date.now;
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const race = Promise.race;
  const clock = now();
  const timers = new Map<number, Turn>();
  const requests: { abort: AbortController; result: Promise<unknown> }[] = [];
  let nextTimer = -1, captures = 0, registrations = 0;
  let changed = latch(), drained = latch();
  let latest: Turn | undefined;
  let closing = false;

  Date.now = () => fromWaitOwner() ? (closing ? Infinity : clock) : now();
  globalThis.setTimeout = ((
    handler: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (!fromWaitOwner()) return schedule(handler, delay, ...args);
    if (typeof handler !== 'function') {
      throw new Error('expected stream wake callback');
    }
    const timer = nextTimer--;
    registrations++;
    latest = { wake: () => handler(...args), capture: latch() };
    timers.set(timer, latest);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (timer) => {
    if (typeof timer !== 'number' || !timers.has(timer)) return cancel(timer);
    timers.delete(timer);
    const previous = drained;
    drained = latch();
    previous.release();
  };
  Promise.race = ((values: Iterable<unknown>) => {
    const owned = fromWaitOwner();
    const turn = owned ? latest : undefined;
    const result = race.call(Promise, [...values]);
    if (!turn) return result;
    // There is no await between the owner's timer registration and this race.
    // Each concurrent HTTP request therefore retains its own captured turn.
    return result.then((snapshot) => {
      turn.relevant = (snapshot as { relevant: boolean }).relevant;
      if (!turn.relevant) {
        captures++;
        const previous = changed;
        changed = latch();
        previous.release();
      }
      turn.capture.release();
      return snapshot;
    });
  }) as typeof Promise.race;

  return {
    start<T>(call: (signal: AbortSignal) => Promise<T>) {
      const baseline = captures;
      const before = registrations;
      const abort = new AbortController();
      const result = call(abort.signal);
      void result.catch(() => undefined);
      requests.push({ abort, result });
      const capture = async () => {
        while (captures <= baseline) {
          await watchdog(
            race.call(Promise, [
              changed.wait,
              result.then(() => {
                throw new Error('stream returned before an irrelevant capture');
              }),
            ]),
            'stream completes an irrelevant capture',
          );
        }
      };
      return {
        result,
        capture,
        get registrations() {
          return registrations - before;
        },
        // Use only after other expected successful requests have been joined.
        async sweep() {
          await capture();
          const active = [...timers.values()];
          if (active.length === 0) {
            throw new Error('stream has no waiting turn');
          }
          const before = captures;
          for (const turn of active) turn.wake();
          // A notification may already have started a fresh capture. Observe its
          // actual verdict too, rather than inferring progress from a sleep.
          await watchdog(
            Promise.all(active.map(async (turn) => {
              await turn.capture.wait;
              if (turn.relevant) {
                throw new Error('unrelated stream capture became relevant');
              }
            })),
            'negative stream capture completes',
          );
          // Waking a completed capture starts another actual capture. Its
          // completion, not a guessed number of microtasks, proves the turn.
          while (captures <= before) {
            await watchdog(
              race.call(Promise, [
                changed.wait,
                result.then(() => {
                  throw new Error(
                    'unrelated stream returned instead of waiting',
                  );
                }),
              ]),
              'next stream capture completes',
            );
          }
        },
        finish: () =>
          watchdog(
            result,
            'notification reaches stream consumer without polling',
          ),
        abort: () => abort.abort(),
      };
    },
    async close() {
      try {
        closing = true;
        for (const turn of timers.values()) turn.wake();
        while (timers.size > 0) {
          await watchdog(drained.wait, 'stream wait owner drains');
        }
        for (const request of requests) request.abort.abort();
        await watchdog(
          Promise.allSettled(requests.map((request) => request.result)),
          'cancelled HTTP requests drain',
        );
      } finally {
        Date.now = now;
        globalThis.setTimeout = schedule;
        globalThis.clearTimeout = cancel;
        Promise.race = race;
      }
    },
  };
}
