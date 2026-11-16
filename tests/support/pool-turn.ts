import { assert } from '@std/assert';
import type { Pool } from '#engine/store/pool.ts';
import { watchdog } from '#tests/support/ordering.ts';

// Drive the real idle-sweep owner at a chosen age, and join both its metadata
// decision and detached native closes. No timer firing or IO latency is assumed.
export async function idleTurns<T>(
  create: () => T | Promise<T>,
  poolFor: (value: T) => Pool,
) {
  const callbacks = new Map<ReturnType<typeof setInterval>, () => void>();
  const set = globalThis.setInterval;
  globalThis.setInterval = Object.assign(
    (...args: Parameters<typeof set>) => {
      const timer = set(...args);
      const [handler, , ...values] = args;
      if (typeof handler === 'function') {
        callbacks.set(timer, () => handler(...values));
      }
      return timer;
    },
    set,
  );
  let value: T;
  try {
    value = await create();
  } finally {
    globalThis.setInterval = set;
  }
  const pool = poolFor(value);
  const timer =
    (pool as unknown as { sweeper: ReturnType<typeof set> }).sweeper;
  const sweep = callbacks.get(timer);
  assert(sweep, 'pool must register its actual idle-sweep callback');
  clearInterval(timer);
  return { value, turn: (ageMs: number) => idleTurn(pool, ageMs, sweep) };
}

async function idleTurn(pool: Pool, ageMs: number, sweep: () => void) {
  const state = pool as unknown as {
    entries: Map<string, { lastUsed: number }>;
    queue: Promise<unknown>;
    fileWork: Map<string, Promise<unknown>>;
  };
  const now = Date.now;
  const lastUsed = Math.max(
    ...[...state.entries.values()].map((entry) => entry.lastUsed),
  );
  try {
    Date.now = () => lastUsed + ageMs;
    sweep();
    await watchdog(state.queue, 'idle sweep metadata turn');
  } finally {
    Date.now = now;
  }
  await watchdog(
    Promise.all(state.fileWork.values()),
    'idle sweep native closes',
  );
}
