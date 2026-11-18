// Read-only operator projection. Never invoke an exporter to inspect lag: some
// snapshot source cuts are allocated by export itself, not by client acceptance.
import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import { openRoom } from '#engine/room/index.ts';
import { publicInventory } from '#engine/tenant/public-replica.ts';

type ProgressCut = { sequence: number; hash: string; sourceCut: number | null };
type ProgressStream = {
  peer: string;
  direction: string;
  source: string;
  incarnation: string;
  scope: string;
  received: ProgressCut;
  published: ProgressCut | null;
  applied: ProgressCut;
  ready: boolean;
  declaredCut: number | null;
};

export async function replicationProgress(
  store: Store,
  self: string,
  role: 'home' | 'facade',
  scopes?: readonly string[],
): Promise<
  { sources: { scope: string; cut: number }[]; streams: ProgressStream[] }
> {
  const selected = (scope: string) => !scopes || scopes.includes(scope);
  const sources: { scope: string; cut: number }[] = [];
  // Only the home is authoritative for these local mutation cuts. Opening a
  // missing room/tenant for status must never provision one.
  if (role === 'home') {
    for (const id of await store.rooms()) {
      const scope = 'room:' + id;
      if (!selected(scope)) continue;
      const room = await openRoom(store, id);
      const cut = await room.tx((tx) => tx.changes.head());
      sources.push({ scope, cut });
    }
    if (!scopes || scopes.some((scope) => scope.startsWith('public:'))) {
      const inventory = await (await store.tenant(self)).tx(publicInventory);
      for (const localpart of inventory.users) {
        const scope = 'public:@' + localpart + ':' + self;
        if (selected(scope)) sources.push({ scope, cut: inventory.cut });
      }
    }
  }
  const streams = await (await store.server()).tx(async (conn) => {
    const result: ProgressStream[] = [];
    for (
      const row of await conn.query(
        'SELECT * FROM facade_streams ORDER BY peer,direction,source,incarnation,stream',
      )
    ) {
      const scope = String(row.stream);
      if (!selected(scope)) continue;
      const identity = [
        row.peer,
        row.direction,
        row.source,
        row.incarnation,
        row.stream,
      ];
      const cut = async (
        sequence: number,
        hash: string,
      ): Promise<ProgressCut> => ({
        sequence,
        hash,
        sourceCut: await semanticCut(conn, identity, sequence),
      });
      const received = await cut(
        Number(row.received),
        String(row.received_hash),
      );
      let applied = await cut(Number(row.applied), String(row.applied_hash));
      let observed = received;
      let published: ProgressCut | null = null;
      let ready = false;
      if (row.direction === 'out') {
        published = received;
        const [ack] = await conn.query(
          'SELECT received,received_hash,applied,applied_hash FROM facade_export_acks WHERE peer=? AND source=? AND incarnation=? AND stream=?',
          [row.peer, row.source, row.incarnation, row.stream],
        );
        observed = await cut(
          Number(ack?.received ?? 0),
          String(ack?.received_hash ?? ''),
        );
        applied = await cut(
          Number(ack?.applied ?? 0),
          String(ack?.applied_hash ?? ''),
        );
        ready = applied.sequence > 0;
      } else {
        const [held] = await conn.query(
          'SELECT ready,pending_hash FROM facade_scopes WHERE incarnation=? AND scope=?',
          [row.incarnation, row.stream],
        );
        ready = held?.ready === 1 && held.pending_hash === null;
        if (ready) published = applied;
      }
      const [declared] = await conn.query(
        "SELECT c.value AS cut FROM facade_streams s JOIN facade_records r ON r.peer=s.peer AND r.direction=s.direction AND r.source=s.source AND r.incarnation=s.incarnation AND r.stream=s.stream AND r.sequence=s.applied JOIN json_each(json_extract(r.record_json,'$.payload.view.cuts')) c ON c.key=? WHERE s.peer=? AND s.direction='in' AND s.source=? AND s.incarnation=? AND s.stream='directory'",
        [scope, row.peer, row.source, row.incarnation],
      );
      result.push({
        peer: String(row.peer),
        direction: String(row.direction),
        source: String(row.source),
        incarnation: String(row.incarnation),
        scope,
        received: observed,
        published,
        applied,
        ready,
        declaredCut: declared ? Number(declared.cut) : null,
      });
    }
    return result;
  });
  return {
    sources: sources.sort((a, b) => a.scope.localeCompare(b.scope)),
    streams,
  };
}

async function semanticCut(
  conn: Conn,
  identity: unknown[],
  sequence: number,
): Promise<number | null> {
  if (!sequence) return null;
  // Explicit scalar allowlist: credentials, bodies, keys and arbitrary record
  // payloads never cross this inspection boundary (including account-auth).
  const [row] = await conn.query(
    "SELECT COALESCE(json_extract(record_json,'$.payload.manifest.cut'),json_extract(record_json,'$.payload.signed.body.sourceCut'),json_extract(record_json,'$.payload.view.cut'),json_extract(record_json,'$.payload.cut')) AS cut FROM facade_records WHERE peer=? AND direction=? AND source=? AND incarnation=? AND stream=? AND sequence=?",
    [...identity, sequence] as (string | number)[],
  );
  return typeof row?.cut === 'number' && Number.isSafeInteger(row.cut) &&
      row.cut >= 0
    ? row.cut
    : null;
}
