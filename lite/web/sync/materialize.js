// sync/materialize.js — THE only writer of the `state` table on the
// browser engine. The F0 invariant: no path writes `state` except the
// resolver — ingest, heal, and adoption alike funnel their resolved
// state map through here. (The filename carries the function name so
// the phase gate's `grep INSERT.*state | grep -v materialize` proves it.)
import { canonicalJson } from './canonical.js';

// rows: [{type, stateKey, eventId, content}] — the resolver's output.
// State is the resolver's materialized cache: wipe + rewrite.
export function materialize(db, rows) {
  db.exec('DELETE FROM state');
  for (const r of rows) {
    db.exec({
      sql: 'INSERT INTO state VALUES (?,?,?,?)',
      bind: [r.type, r.stateKey, r.eventId, canonicalJson(r.content)],
    });
  }
}
