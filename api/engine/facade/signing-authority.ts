// One process-local authority per file. Storage owns its shared/exclusive commit
// permits; crypto checks use the same revision without cross-file room reads.
import { MatrixError } from '#engine/matrix-error.ts';
import type { Conn, Database } from '#engine/store/db.ts';
import { Admission } from '#engine/store/admission.ts';
import type { CommitCheck } from '#engine/store/commit.ts';

/** The same retryable dependency at journal and public Matrix consumers. */
export class VerificationUnavailable extends MatrixError {
  readonly code = 'LINK_UNAVAILABLE';

  constructor(message: string) {
    super(503, 'M_UNAVAILABLE', message);
  }
}

type Fence = { revision: number; writing: number; commits: Admission };
const fences = new Map<string, WeakRef<Fence>>();
const collected = new FinalizationRegistry<string>((path) => {
  if (!fences.get(path)?.deref()) fences.delete(path);
});

function fenceFor(db: Database): Fence {
  let fence = fences.get(db.path)?.deref();
  if (!fence) {
    fence = { revision: 0, writing: 0, commits: new Admission() };
    fences.set(db.path, new WeakRef(fence));
    collected.register(fence, db.path);
  }
  return fence;
}

function authorityFence(db: Database, changed: () => Error): CommitCheck {
  const fence = fenceFor(db), revision = fence.revision;
  const check = () => {
    if (fence.writing || fence.revision !== revision) {
      throw changed();
    }
  };
  return Object.assign(check, { permits: [fence.commits] });
}

export function signingFence(db: Database): CommitCheck {
  return authorityFence(db, () =>
    new MatrixError(
      503,
      'M_UNAVAILABLE',
      'facade signing authority changed',
    ));
}

/** Verification waits for the authority owner, never rejects a PDU merely
 * because its approved control cut is still being installed. */
export function verificationFence(db: Database): CommitCheck {
  return authorityFence(
    db,
    () => new VerificationUnavailable('facade verification authority changed'),
  );
}

type AuthorityWrite<T> = (conn: Conn) => Promise<T>;

export function changeSigningAuthority<T>(
  db: Database,
  write: AuthorityWrite<T>,
): Promise<T>;
export function changeSigningAuthority<R, T>(
  db: Database,
  write: AuthorityWrite<R>,
  run: (write: AuthorityWrite<R>) => Promise<T>,
): Promise<T>;
export async function changeSigningAuthority<R, T = R>(
  db: Database,
  write: AuthorityWrite<R>,
  run?: (write: AuthorityWrite<R>) => Promise<T>,
): Promise<R | T> {
  const fence = fenceFor(db);
  fence.writing++;
  fence.revision++;
  try {
    // The owner enlists this in its actual transaction, so both sides acquire
    // authority only AFTER common snapshot admission. Private MVCC rows are not
    // retirement publication; the exclusive native write is that boundary.
    const admit = Object.assign(() => {}, {
      permits: [{
        run: async <R>(commit: () => Promise<R>) =>
          (await fence.commits.exclusive(commit)).value,
      }],
    });
    const admitted = (conn: Conn) => {
      conn.admit(admit);
      return write(conn);
    };
    // An existing domain owner (e.g. Journal.apply) keeps its own transaction
    // capability. The authority wraps its callback, never bypasses that owner.
    return run ? await run(admitted) : await db.tx(admitted);
  } finally {
    // Also drain invalidations with no database mutation (and pending commits
    // when a writer aborts). No authority is republished before the drain.
    await fence.commits.exclusive(() => Promise.resolve());
    // Also fence permits captured while the database transaction was pending.
    fence.revision++;
    fence.writing--;
  }
}
