// Cross-file replica completion. A domain commits independently and idempotently;
// readiness, its terminal result and contiguous journal application commit once.
import type { Conn, Database } from '#engine/store/db.ts';
import { changedColumns } from '#engine/store/changed.ts';
import type { Journal } from './journal.ts';
import { canonicalJson } from '#engine/canonical.ts';
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
  // Only home composition supplies a pairing. Facade readers retain their
  // single active home binding and the F1 source contract by default.
  pairing?: string;
  authorize?(conn: Conn): Promise<void>;
  // A snapshot owner may prove these predecessors subsumed by record. They
  // still receive individual durable results in the same contiguous commit.
  superseded?: readonly { record: LinkRecord; result: unknown }[];
  apply(): Promise<unknown>;
  // A control revision may supersede an authenticated snapshot while its
  // independent stream drains. Consume that source cut without enabling it.
  ready?(conn: Conn): Promise<boolean>;
}): Promise<boolean> {
  const { db, journal, stream, record, scope, after, cut } = options;
  const connection = options.pairing
    ? await options.pairings.connection(options.pairing)
    : undefined;
  const grant = connection?.grant ??
    (connection ? null : await options.pairings.active());
  if (!grant || (connection && connection.state !== 'paired')) {
    throw new LinkError('LINK_UNPAIRED', 'replica requires paired source', 403);
  }
  const prefix = [...(options.superseded ?? []), { record, result: undefined }];
  const entries = new Map(
    prefix.map((entry) => [entry.record.sequence, entry]),
  );
  const context = grant.body.transcript.body.context;
  const peer = connection ? context.node : 'home';
  const source = peer;
  const incarnation = connection
    ? grant.body.transcript.body.incarnation
    : context.id;
  if (
    (connection && context.id !== options.pairing) ||
    prefix.some((entry, index) =>
      entry.record.source !== source ||
      entry.record.incarnation !== incarnation ||
      entry.record.stream !== scope ||
      (index > 0 &&
        entry.record.sequence !== prefix[index - 1].record.sequence + 1)
    ) ||
    context.server !== options.self || scope !== stream.stream
  ) {
    throw new LinkError(
      'LINK_IDENTITY_MISMATCH',
      'replica source or scope does not match grant',
      403,
    );
  }
  const checkGrant = async (conn: Conn) => {
    const [binding] = await conn.query(
      'SELECT state,revision,grant_json FROM facade_pairings WHERE id=? AND side=?',
      [context.id, connection ? 'home' : 'facade'],
    );
    if (
      binding?.state !== 'paired' ||
      Number(binding.revision) !== grant.body.revision ||
      binding.grant_json !== canonicalJson(grant)
    ) throw new LinkError('LINK_UNPAIRED', 'replica grant changed', 403);
    await options.authorize?.(conn);
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
      'INSERT INTO facade_scopes(incarnation,scope,source_cut,ready,pending_hash) VALUES(?,?,?,0,?) ON CONFLICT(incarnation,scope) DO UPDATE SET ready=0,pending_hash=excluded.pending_hash WHERE ' +
        changedColumns('facade_scopes', 'ready', 'pending_hash'),
      [context.id, scope, after, record.hash],
    );
  });
  const result = await options.apply();
  return await journal.apply(
    peer,
    stream,
    async (conn, current) => {
      await checkGrant(conn);
      const entry = entries.get(current.sequence);
      if (current.hash !== entry?.record.hash) {
        throw new LinkError('LINK_DIVERGED', 'replica application raced');
      }
      if (current.hash !== record.hash) return entry.result;
      const ready = options.ready ? await options.ready(conn) : true;
      const changed = await conn.execute(
        'UPDATE facade_scopes SET source_cut=?,ready=?,pending_hash=NULL WHERE incarnation=? AND scope=? AND source_cut=? AND pending_hash=?',
        [cut, ready ? 1 : 0, context.id, scope, after, record.hash],
      );
      if (changed !== 1) {
        throw new LinkError(
          'LINK_DIVERGED',
          'replica completion lost its pending identity',
        );
      }
      return result;
    },
    options.superseded?.length
      ? { sequence: record.sequence, hash: record.hash }
      : undefined,
  );
}
