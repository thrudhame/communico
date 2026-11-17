// Observe the sender's real sleep registrations and loop completion. Other
// owners retain their wall clocks and timers, including TLS and native storage.
import { assert } from '@std/assert';
import { latch, watchdog } from './ordering.ts';

function fromSenderOwner() {
  const caller = new Error().stack?.split('\n').slice(1).find((frame) =>
    !frame.includes('/tests/support/sender-turn.ts:')
  );
  return caller?.includes('/api/engine/federation/sender.ts:') === true;
}

export function observeSenderWait() {
  const now = Date.now;
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const finalize = Promise.prototype.finally;
  let clock = now(), nextTimer = -1;
  let changed = latch();
  type Turn = { delay: number; fire: () => void; active: boolean };
  const turns: Turn[] = [];
  const timers = new Map<number, Turn>();
  const loops: Promise<unknown>[] = [];
  Date.now = () => fromSenderOwner() ? clock : now();
  globalThis.setTimeout = ((
    handler: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (!fromSenderOwner()) return schedule(handler, delay, ...args);
    const id = nextTimer--;
    const turn = {
      delay: delay ?? 0,
      fire: () => handler(...args),
      active: true,
    };
    turns.push(turn);
    timers.set(id, turn);
    const previous = changed;
    changed = latch();
    previous.release();
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (id) => {
    const turn = typeof id === 'number' ? timers.get(id) : undefined;
    if (!turn) return cancel(id);
    turn.active = false;
    timers.delete(id as number);
  };
  Promise.prototype.finally = function (this: Promise<unknown>, callback) {
    const result = finalize.call(this, callback);
    if (fromSenderOwner()) loops.push(result);
    return result;
  } as typeof Promise.prototype.finally;

  return {
    count: () => turns.length,
    now: () => clock,
    async after(count: number) {
      while (turns.length <= count) {
        await watchdog(
          changed.wait,
          'sender registers its next real retry/backoff wait',
        );
      }
      return turns.at(-1)!;
    },
    advance() {
      const turn = turns.at(-1);
      assert(turn?.active, 'sender has an active policy wait');
      clock += turn.delay;
      turn.fire();
    },
    async drain() {
      assert(loops.length > 0, 'observe the actual sender loop finalizer');
      let joined = 0;
      do {
        joined = loops.length;
        await watchdog(
          Promise.all(loops),
          'blocked sender finishes its actual loop',
        );
      } while (joined !== loops.length);
    },
    restore() {
      Date.now = now;
      globalThis.setTimeout = schedule;
      globalThis.clearTimeout = cancel;
      Promise.prototype.finally = finalize;
      assert(
        timers.size === 0,
        'sender waits are drained before restoring hooks',
      );
    },
  };
}
