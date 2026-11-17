import { assert } from '@std/assert';
import { latch } from './ordering.ts';

// Observe the complete worker group handed to the composition owner's join.
// TLS replies can stay held while the test checks the entire admitted group;
// a fifth worker cannot hide behind a later transport scheduling turn.
export function observeOriginWorkers() {
  const allSettled = Promise.allSettled;
  const enrolled = latch();
  let count: number | undefined;
  Promise.allSettled = function (values: Iterable<unknown>) {
    const caller = new Error().stack?.split('\n').slice(1).find((frame) =>
      !frame.includes('/tests/support/origin-workers.ts:')
    );
    const result = allSettled.call(Promise, values);
    if (caller?.includes('/api/engine/client/e2ee.ts:')) {
      assert(
        Array.isArray(values),
        'origin owner joins its complete worker array',
      );
      count = values.length;
      enrolled.release();
    }
    return result;
  } as typeof Promise.allSettled;
  return {
    enrolled: enrolled.wait,
    count: () => count,
    restore: () => Promise.allSettled = allSettled,
  };
}
