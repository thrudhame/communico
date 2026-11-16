// A permit cannot query another file while its consumer holds a room transaction.
// Pairing and roster owners fence it synchronously around every authority write.
import { MatrixError } from '#engine/matrix-error.ts';
import type { Database } from '#engine/store/db.ts';

type Fence = { revision: number; writing: number };
const fences = new Map<string, WeakRef<Fence>>();
const collected = new FinalizationRegistry<string>((path) => {
  if (!fences.get(path)?.deref()) fences.delete(path);
});

function fenceFor(db: Database): Fence {
  let fence = fences.get(db.path)?.deref();
  if (!fence) {
    fence = { revision: 0, writing: 0 };
    fences.set(db.path, new WeakRef(fence));
    collected.register(fence, db.path);
  }
  return fence;
}

export function signingFence(db: Database): () => void {
  const fence = fenceFor(db), revision = fence.revision;
  return () => {
    if (fence.writing || fence.revision !== revision) {
      throw new MatrixError(
        503,
        'M_UNAVAILABLE',
        'facade signing authority changed',
      );
    }
  };
}

export async function changeSigningAuthority<T>(
  db: Database,
  write: () => Promise<T>,
): Promise<T> {
  const fence = fenceFor(db);
  fence.writing++;
  fence.revision++;
  try {
    return await write();
  } finally {
    // Also fence permits captured while the database transaction was pending.
    fence.revision++;
    fence.writing--;
  }
}
