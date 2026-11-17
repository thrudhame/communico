import { assert } from '@std/assert';
import { MediaCache } from '#engine/media/cache.ts';
import type { CachedMedia } from '#engine/server/media.ts';
import { latch } from '#tests/support/ordering.ts';

type Entry = {
  users: number;
  controller: AbortController;
  run: Promise<CachedMedia>;
};

// Both unit and HTTP consumers observe the same actual subscription owner.
export function mediaDemand(cache?: MediaCache) {
  const prototype = MediaCache.prototype as unknown as {
    subscribe(
      this: MediaCache,
      entry: Entry,
      signal?: AbortSignal,
    ): Promise<CachedMedia>;
  };
  const subscribe = prototype.subscribe;
  const joined = latch();
  const firstLeft = latch(), lastLeft = latch();
  const owners = new Set<MediaCache>();
  let shared: Entry | undefined;
  prototype.subscribe = function (entry, signal) {
    const pending = subscribe.call(this, entry, signal);
    if (cache === undefined || cache === this) {
      owners.add(this);
      if (entry.users === 2) {
        shared = entry;
        joined.release();
      }
      // A client disconnect can reject its fetch before the server has left
      // this subscription. Observe settlement after the owner's finally.
      const settled = () => {
        if (entry !== shared) return;
        if (entry.users === 1) firstLeft.release();
        if (entry.users === 0) lastLeft.release();
      };
      void pending.then(settled, settled);
    }
    return pending;
  };
  return {
    joined: joined.wait,
    firstLeft: firstLeft.wait,
    lastLeft: lastLeft.wait,
    get entry() {
      assert(shared, 'two callers must actually join the same media owner');
      return shared;
    },
    async close() {
      for (const owner of owners) await owner.close();
    },
    restore() {
      prototype.subscribe = subscribe;
    },
  };
}
