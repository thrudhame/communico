import { assert, assertEquals } from '@std/assert';
import { latch } from '#tests/support/ordering.ts';

// Keep the real registration and requested policy duration observable, but let
// the test drive its callback only after the relevant asynchronous owner enters.
export function controlledTimeouts(delay: number) {
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const entered = latch();
  const timers: {
    id: ReturnType<typeof set>;
    active: boolean;
    fire: () => void;
  }[] = [];
  globalThis.setTimeout = Object.assign((...args: Parameters<typeof set>) => {
    const [handler, ms, ...values] = args;
    if (ms !== delay) return set(...args);
    assert(typeof handler === 'function');
    const id = set(() => {}, 0);
    clear(id);
    const timer = {
      id,
      active: true,
      fire() {
        assert(timer.active, 'controlled deadline must still be armed');
        timer.active = false;
        handler(...values);
      },
    };
    timers.push(timer);
    entered.release();
    return id;
  }, set);
  globalThis.clearTimeout = (id) => {
    const timer = timers.find((timer) => timer.id === id);
    if (timer) timer.active = false;
    clear(id);
  };
  return {
    timers,
    registered: entered.wait,
    restore() {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
      for (const timer of timers) clear(timer.id);
    },
  };
}

export function controlledDeadline(delay: number) {
  const timeout = AbortSignal.timeout;
  const controller = new AbortController();
  let registrations = 0;
  AbortSignal.timeout = (ms) => {
    if (ms !== delay) return timeout(ms);
    registrations++;
    return controller.signal;
  };
  return {
    fire() {
      assertEquals(
        registrations,
        1,
        'configured total deadline registered once',
      );
      controller.abort(new DOMException('Signal timed out.', 'TimeoutError'));
    },
    restore() {
      AbortSignal.timeout = timeout;
    },
  };
}
