// Semantic operator decisions, separate from independently acquired key caches.
// The acquisition timestamp travels unchanged so reconciliation cannot renew a key.
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Conn } from '#engine/store/db.ts';
import { keyDocument, oldKeysOf } from './key-document.ts';
import type { KeyDocShape } from './witness.ts';

export const KEY_DECISIONS_SQL = `
CREATE TABLE server_key_decisions(server_name TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, decision_json TEXT NOT NULL);
INSERT INTO server_key_decisions(server_name,revision,decision_json) SELECT server_name,1,json_object('name',server_name,'revision',1,'action','accept','doc',json(key_json),'acquired',fetched_ms) FROM server_key_docs WHERE via='accepted';
`;
export type KeyDecision =
  & { name: string; revision: number }
  & (
    | { action: 'accept'; doc: KeyDocShape; acquired: number }
    | { action: 'forget' }
  );
type DecisionBody =
  | { action: 'accept'; doc: KeyDocShape; acquired: number }
  | { action: 'forget' };

export function keyDecisionsOf(raw: unknown): KeyDecision[] {
  const bad = (): never => {
    throw new MatrixError(400, 'M_BAD_JSON', 'invalid remote key decisions');
  };
  if (!Array.isArray(raw)) return bad();
  const decisions = raw.map((v): KeyDecision => {
    if (
      !v || typeof v !== 'object' || typeof v.name !== 'string' || !v.name ||
      !Number.isSafeInteger(v.revision) || v.revision < 1
    ) return bad();
    if (v.action === 'forget') {
      return { name: v.name, revision: v.revision, action: 'forget' };
    }
    if (
      v.action !== 'accept' || !Number.isSafeInteger(v.acquired) ||
      v.acquired < 0
    ) return bad();
    const doc = keyDocument(v.doc);
    if (doc.server_name !== v.name) return bad();
    return {
      name: v.name,
      revision: v.revision,
      action: 'accept',
      doc,
      acquired: v.acquired,
    };
  });
  if (new Set(decisions.map((d) => d.name)).size !== decisions.length) bad();
  return decisions;
}

export async function exportKeyDecisions(
  conn: Pick<Conn, 'query'>,
): Promise<KeyDecision[]> {
  return keyDecisionsOf((await conn.query(
    'SELECT decision_json FROM server_key_decisions ORDER BY server_name',
  )).map((row) => JSON.parse(String(row.decision_json))));
}

export async function recordKeyDecision(
  conn: Conn,
  name: string,
  body: DecisionBody,
): Promise<void> {
  const [prior] = await conn.query(
    'SELECT revision FROM server_key_decisions WHERE server_name=?',
    [name],
  );
  const revision = prior ? Number(prior.revision) + 1 : 1;
  await saveKeyDecision(conn, { name, revision, ...body });
}

export async function saveKeyDecision(
  conn: Conn,
  decision: KeyDecision,
): Promise<boolean> {
  const [prior] = await conn.query(
    'SELECT revision,decision_json FROM server_key_decisions WHERE server_name=?',
    [decision.name],
  );
  if (prior) {
    if (
      Number(prior.revision) > decision.revision ||
      (Number(prior.revision) === decision.revision &&
        canonicalJson(JSON.parse(String(prior.decision_json))) !==
          canonicalJson(decision))
    ) throw new MatrixError(409, 'M_BAD_JSON', 'remote key decision diverged');
    if (Number(prior.revision) === decision.revision) return false;
  }
  await conn.execute(
    'INSERT INTO server_key_decisions(server_name,revision,decision_json) VALUES(?,?,?) ON CONFLICT(server_name) DO UPDATE SET revision=excluded.revision,decision_json=excluded.decision_json',
    [decision.name, decision.revision, JSON.stringify(decision)],
  );
  return true;
}

export async function persistKeyDocument(
  conn: Conn,
  name: string,
  doc: KeyDocShape,
  via: string,
  fetched: number,
): Promise<void> {
  const until = Math.min(doc.valid_until_ts, fetched + 7 * 86400_000);
  await conn.execute(
    'INSERT INTO server_key_docs(server_name,key_json,fetched_ms,via) VALUES(?,?,?,?) ON CONFLICT(server_name) DO UPDATE SET key_json=excluded.key_json,fetched_ms=excluded.fetched_ms,via=excluded.via',
    [name, JSON.stringify(doc), fetched, via],
  );
  await conn.execute('DELETE FROM server_keys WHERE server_name=?', [name]);
  for (const [id, entry] of Object.entries(doc.verify_keys)) {
    await conn.execute(
      'INSERT INTO server_keys(server_name,key_id,pubkey_b64,valid_until_ts,fetched_ms,expired_ts) VALUES(?,?,?,?,?,NULL)',
      [name, id, entry.key, until, fetched],
    );
  }
  for (const [id, entry] of Object.entries(oldKeysOf(doc))) {
    await conn.execute(
      'INSERT INTO server_keys(server_name,key_id,pubkey_b64,valid_until_ts,fetched_ms,expired_ts) VALUES(?,?,?,?,?,?)',
      [name, id, entry.key, until, fetched, entry.expired_ts],
    );
  }
}
