// Exact tenant-owned application evidence bridges owner commit -> journal ACK.
// It permits only completion of that immutable record, never new link work.
import { canonicalJson } from '#engine/canonical.ts';
import { LinkError, type LinkRecord } from '#engine/facade/protocol.ts';
import type { Conn } from '#engine/store/db.ts';

export const LINK_APPLICATIONS_SQL = `
CREATE TABLE facade_link_applications(peer TEXT NOT NULL,source TEXT NOT NULL,incarnation TEXT NOT NULL,stream TEXT NOT NULL,sequence INTEGER NOT NULL,hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(peer,source,incarnation,stream,sequence));
`;

function key(peer: string, record: LinkRecord) {
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
  record: LinkRecord,
): Promise<{ result: unknown } | null> {
  const [row] = await conn.query(
    'SELECT hash,result_json FROM facade_link_applications WHERE peer=? AND source=? AND incarnation=? AND stream=? AND sequence=?',
    key(peer, record),
  );
  if (!row) return null;
  if (row.hash !== record.hash) {
    throw new LinkError('LINK_DIVERGED', 'changed tenant application record');
  }
  return { result: JSON.parse(String(row.result_json)) };
}

export async function retainLinkApplication(
  conn: Conn,
  peer: string,
  record: LinkRecord,
  result: unknown,
): Promise<void> {
  const prior = await linkApplication(conn, peer, record);
  if (prior) {
    if (canonicalJson(prior.result) !== canonicalJson(result)) {
      throw new LinkError('LINK_DIVERGED', 'changed tenant application result');
    }
    return;
  }
  await conn.execute(
    'INSERT INTO facade_link_applications VALUES(?,?,?,?,?,?,?)',
    [...key(peer, record), record.hash, canonicalJson(result)],
  );
}
