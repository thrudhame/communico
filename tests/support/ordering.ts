// Causal test observations. The timer is only a deadlock watchdog, never a
// latency assertion; callers keep the competing owner held until completion.
export function latch() {
  const { promise, resolve } = Promise.withResolvers<void>();
  let released = false;
  return {
    wait: promise,
    get released() {
      return released;
    },
    release() {
      released = true;
      resolve();
    },
  };
}

export async function watchdog<T>(
  task: Promise<T>,
  contract: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('ordering watchdog: ' + contract)),
          30000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Observe the real owner enrolling its waiter, not merely the caller starting.
export function enrollment<T>(waiters: T[]) {
  const entered = latch();
  const push = waiters.push;
  waiters.push = function (...values: T[]) {
    const length = push.apply(this, values);
    entered.release();
    return length;
  };
  return { wait: entered.wait, restore: () => waiters.push = push };
}

// Promise.allSettled enumerates the accepted tasks before awaiting their drain.
export function drainEnrollment(tasks: Set<Promise<unknown>>) {
  const entered = latch();
  const iterate = tasks[Symbol.iterator];
  tasks[Symbol.iterator] = function () {
    const iterator = iterate.call(this);
    const next = iterator.next.bind(iterator);
    iterator.next = () => {
      const result = next();
      if (result.done) entered.release();
      return result;
    };
    return iterator;
  };
  return {
    wait: entered.wait,
    restore: () => tasks[Symbol.iterator] = iterate,
  };
}
