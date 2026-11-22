// Exact tenant-owned application evidence bridges owner commit -> journal ACK.
// It permits only completion of that immutable record, never new link work.
import { canonicalJson } from '#engine/canonical.ts';
import { LinkError, type LinkRecord } from '#engine/facade/protocol.ts';
import type { Conn } from '#engine/store/db.ts';
import { pendingTenantProjection } from './hooks.ts';

export const LINK_APPLICATIONS_SQL = `
CREATE TABLE facade_link_applications(peer TEXT NOT NULL,source TEXT NOT NULL,incarnation TEXT NOT NULL,stream TEXT NOT NULL,sequence INTEGER NOT NULL,hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(peer,source,incarnation,stream,sequence));
`;

// NULL distinguishes old evidence from a receipt that deliberately owns no
// projection. Keep the upgrade's older pending cut for local capture witnesses
// that did not exist before this metadata was introduced.
export const LINK_APPLICATION_PROJECTION_SQL = `
ALTER TABLE facade_link_applications ADD COLUMN projection_revision INTEGER;
INSERT INTO counters(name,value) SELECT 'facade_projection_legacy',value FROM counters WHERE name='projection_pending';
`;

export type LinkApplicationIdentity = Pick<
  LinkRecord,
  'source' | 'incarnation' | 'stream' | 'sequence' | 'hash'
>;

function key(peer: string, record: LinkApplicationIdentity) {
  return [
    peer,
    record.source,
    record.incarnation,
    record.stream,
    record.sequence,
  ];
}

export async function linkApplication(
  conn: Conn,
  peer: string,
  record: LinkApplicationIdentity,
): Promise<{ result: unknown; projectionRevision?: number } | null> {
  const [row] = await conn.query(
    'SELECT hash,result_json,projection_revision FROM facade_link_applications WHERE peer=? AND source=? AND incarnation=? AND stream=? AND sequence=?',
    key(peer, record),
  );
  if (!row) return null;
  if (row.hash !== record.hash) {
    throw new LinkError('LINK_DIVERGED', 'changed tenant application record');
  }
  return {
    result: JSON.parse(String(row.result_json)),
    ...(row.projection_revision === null
      ? {}
      : { projectionRevision: Number(row.projection_revision) }),
  };
}

/** Replay owns its committed cut, not whatever another mutation owes now.
 * Metadata-absent evidence is deliberately conservative. */
export async function linkApplicationProjection(
  conn: Conn,
  application: { projectionRevision?: number },
): Promise<number> {
  return application.projectionRevision ?? await pendingTenantProjection(conn);
}

/** The tenant transaction owns state, semantic result, publication hints and
 * completion together. Local ingress/capture uses its durable operation/cut
 * identity at this same boundary, so a crash cannot lose an earlier obligation. */
export async function applyLinkApplication<T>(
  conn: Conn,
  peer: string,
  record: LinkApplicationIdentity,
  apply: () => Promise<
    { result: T; projectionRevision?: number; retain?: boolean }
  >,
  legacyCapture = false,
): Promise<{ result: T; projectionRevision: number }> {
  const prior = await linkApplication(conn, peer, record);
  if (prior) {
    return {
      result: prior.result as T,
      projectionRevision: await linkApplicationProjection(conn, prior),
    };
  }
  const before = await pendingTenantProjection(conn);
  const applied = await apply();
  const pending = await pendingTenantProjection(conn);
  const [legacy] = legacyCapture
    ? await conn.query(
      "SELECT value FROM counters WHERE name='facade_projection_legacy'",
    )
    : [];
  const projectionRevision = Math.max(
    applied.projectionRevision ?? (pending !== before ? pending : 0),
    Number(legacy?.value ?? 0),
  );
  // Projection debt is independently durable in the tenant counters. It must
  // not turn an explicitly empty capture into a completed result: that capture
  // identity remains current until actual source work advances its export cut.
  if (applied.retain !== false) {
    await retainLinkApplication(
      conn,
      peer,
      record,
      applied.result,
      projectionRevision,
    );
  }
  return { result: applied.result, projectionRevision };
}

export async function retainLinkApplication(
  conn: Conn,
  peer: string,
  record: LinkApplicationIdentity,
  result: unknown,
  projectionRevision?: number,
): Promise<void> {
  const prior = await linkApplication(conn, peer, record);
  if (prior) {
    if (
      canonicalJson(prior.result) !== canonicalJson(result) ||
      prior.projectionRevision !== projectionRevision
    ) {
      throw new LinkError('LINK_DIVERGED', 'changed tenant application result');
    }
    return;
  }
  await conn.execute(
    'INSERT INTO facade_link_applications(peer,source,incarnation,stream,sequence,hash,result_json,projection_revision) VALUES(?,?,?,?,?,?,?,?)',
    [
      ...key(peer, record),
      record.hash,
      canonicalJson(result),
      projectionRevision ?? null,
    ],
  );
}
