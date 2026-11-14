// Cross-file replica completion. A domain commits independently and idempotently;
// readiness, its terminal result and contiguous journal application commit once.
import type { Conn, Database } from '#engine/store/db.ts';
import type { Journal } from './journal.ts';
import type { Pairings } from './pairing.ts';
import { LinkError, type LinkRecord, type Stream } from './protocol.ts';

export async function applyReplicaScope(options: {
  db: Database;
  pairings: Pairings;
  self: string;
  journal: Journal;
  stream: Stream;
  record: LinkRecord;
  scope: string;
  after: number;
  cut: number;
  apply(): Promise<unknown>;
}): Promise<boolean> {
  const { db, journal, stream, record, scope, after, cut } = options;
  const grant = await options.pairings.active();
  const context = grant.body.transcript.body.context;
  if (
    record.source !== 'home' || record.incarnation !== context.id ||
    context.server !== options.self || scope !== stream.stream
  ) {
    throw new LinkError(
      'LINK_IDENTITY_MISMATCH',
      'replica source or scope does not match home grant',
      403,
    );
  }
  const checkGrant = async (conn: Conn) => {
    const [binding] = await conn.query(
      "SELECT state,revision FROM facade_pairings WHERE id=? AND side='facade'",
      [context.id],
    );
    if (
      binding?.state !== 'paired' ||
      Number(binding.revision) !== grant.body.revision
    ) throw new LinkError('LINK_UNPAIRED', 'replica grant changed', 403);
  };
  await db.tx(async (conn) => {
    await checkGrant(conn);
    const [prior] = await conn.query(
      'SELECT source_cut,pending_hash FROM facade_scopes WHERE incarnation=? AND scope=?',
      [context.id, scope],
    );
    if (
      (prior ? Number(prior.source_cut) : 0) !== after ||
      (prior?.pending_hash && prior.pending_hash !== record.hash)
    ) {
      throw new LinkError(
        'LINK_DIVERGED',
        'replica suffix does not follow applied source cut',
      );
    }
    await conn.execute(
      'INSERT INTO facade_scopes(incarnation,scope,source_cut,ready,pending_hash) VALUES(?,?,?,0,?) ON CONFLICT(incarnation,scope) DO UPDATE SET ready=0,pending_hash=excluded.pending_hash',
      [context.id, scope, after, record.hash],
    );
  });
  const result = await options.apply();
  return await journal.apply('home', stream, async (conn, current) => {
    await checkGrant(conn);
    if (current.hash !== record.hash) {
      throw new LinkError('LINK_DIVERGED', 'replica application raced');
    }
    const changed = await conn.execute(
      'UPDATE facade_scopes SET source_cut=?,ready=1,pending_hash=NULL WHERE incarnation=? AND scope=? AND source_cut=? AND pending_hash=?',
      [cut, context.id, scope, after, record.hash],
    );
    if (changed !== 1) {
      throw new LinkError(
        'LINK_DIVERGED',
        'replica completion lost its pending identity',
      );
    }
    return result;
  });
}
