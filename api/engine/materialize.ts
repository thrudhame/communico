import type pgpkg from 'pg';

export interface StateRowInput {
  type: string;
  stateKey: string;
  eventId: string;
  content: unknown;
}

// THE only writer of the `state` table on the server engine. The F0
// invariant: no path writes `state` except the resolver — ingest, heal,
// and adoption alike funnel their resolved state map through here.
// (The filename carries the function name so the phase gate's
// `grep INSERT.*state | grep -v materialize` proves the invariant.)
export async function materialize(
  c: pgpkg.Client,
  rows: StateRowInput[],
): Promise<void> {
  await c.query('DELETE FROM state;');
  for (const r of rows) {
    await c.query(
      'INSERT INTO state (type, state_key, event_id, content) VALUES ($1, $2, $3, $4);',
      [r.type, r.stateKey, r.eventId, JSON.stringify(r.content)],
    );
  }
}
