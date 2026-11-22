// Exact local admission context is retained before prepared client work can
// escape the room. A retry uses the original context, never a later snapshot.
import type { Conn } from '#engine/store/db.ts';
import { appendChange } from './changes.ts';
import type { LocalJoinObservation } from './hooks.ts';
import { latestStay } from './segments.ts';
import { current, groupKey } from './state.ts';
import { getEvent } from './events.ts';

export const JOIN_OBSERVATIONS_SQL = `
CREATE TABLE local_join_observations(event TEXT PRIMARY KEY NOT NULL,data TEXT NOT NULL);
`;
// Decide from PRE-ingest published room state, never from the receiver's later
// membership projection. A self member update while joined is not a rejoin.
export async function transitionObservation(
  conn: Conn,
  user: string | undefined,
  data: LocalJoinObservation | undefined,
) {
  if (user === undefined || data === undefined) return undefined;
  const stay = await latestStay(conn);
  const group = stay === null ? null : await current(conn, stay.id);
  const id = group === null
    ? null
    : await groupKey(conn, group, 'm.room.member', user);
  const row = id === null ? null : await getEvent(conn, id);
  return row !== null && JSON.parse(row.pdu).content?.membership === 'join'
    ? undefined
    : data;
}
export async function retainJoinObservation(
  conn: Conn,
  event: string,
  user: string | undefined,
  data: LocalJoinObservation | undefined,
) {
  const observation = await transitionObservation(conn, user, data);
  if (observation === undefined) return;
  if ((await conn.query('SELECT 1 FROM events WHERE id=?', [event])).length) {
    return;
  }
  await conn.execute(
    'INSERT INTO local_join_observations(event,data) VALUES(?,?) ON CONFLICT DO NOTHING',
    [event, JSON.stringify(observation)],
  );
}
export async function completeJoinObservation(
  conn: Conn,
  event: string,
  data?: LocalJoinObservation,
) {
  // The retained-row key lookup comes first: every grounded event asks.
  const [retained] = await conn.query(
    'SELECT data FROM local_join_observations WHERE event=?',
    [event],
  );
  const observed = retained ? JSON.parse(String(retained.data)) : data;
  if (observed === undefined) return;
  const [old] = await conn.query(
    "SELECT 1 FROM changes WHERE kind='rejoin-observation' AND event=?",
    [event],
  );
  if (!old) await appendChange(conn, 'rejoin-observation', event, observed);
}
