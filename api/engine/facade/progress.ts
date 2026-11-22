// Read-only operator projection. Never invoke an exporter to inspect lag: some
// snapshot source cuts are allocated by export itself, not by client acceptance.
import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import { openRoom } from '#engine/room/index.ts';
import { publicInventory } from '#engine/tenant/public-replica.ts';

type ProgressCut = { sequence: number; hash: string; sourceCut: number | null };
type SourceCut = {
  scope: string;
  cut: number;
  source?: string;
  incarnation?: string;
};
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
  { sources: SourceCut[]; streams: ProgressStream[] }
> {
  const selected = (scope: string) => !scopes || scopes.includes(scope);
  const sources: SourceCut[] = [];
  // Each role owns its local room mutation heads. Opening a missing room or
  // tenant for status must never provision one; public account cuts stay home-owned.
  for (const id of await store.rooms()) {
    const scope = 'room:' + id;
    if (!selected(scope)) continue;
    const room = await openRoom(store, id);
    const cut = await room.tx((tx) => tx.changes.head());
    sources.push({ scope, cut });
  }
  if (role === 'home') {
    if (!scopes || scopes.some((scope) => scope.startsWith('public:'))) {
      const inventory = await (await store.tenant(self)).tx(publicInventory);
      for (const localpart of inventory.users) {
        const scope = 'public:@' + localpart + ':' + self;
        if (selected(scope)) sources.push({ scope, cut: inventory.cut });
      }
    }
  }
  const streams = await (await store.server()).tx(async (conn) => {
    // OOB heads belong to the current local source, not retained foreign or
    // historical operations. Bind the capture to its current transport too.
    for (
      const row of await conn.query(
        'WITH local_identity AS (' + (role === 'home'
          ? 'SELECT node,incarnation FROM publication_domain WHERE singleton=1'
          : 'SELECT node_id AS node,incarnation FROM facade_node WHERE singleton=1') +
          ") SELECT o.stream AS scope,MAX(o.sequence) AS cut,p.node,p.incarnation,b.id FROM domain_operations o JOIN local_identity p ON o.source=p.node AND o.incarnation=p.incarnation JOIN facade_pairings b ON b.side=? AND b.state='paired' WHERE o.kind='membership' GROUP BY o.stream,p.node,p.incarnation,b.id",
        [role],
      )
    ) {
      const scope = String(row.scope);
      if (selected(scope)) {
        sources.push({
          scope,
          cut: Number(row.cut),
          source: String(row.node),
          incarnation: String(role === 'home' ? row.id : row.incarnation),
        });
      }
    }
    const result: ProgressStream[] = [];
    for (
      const row of await conn.query(
        'SELECT * FROM facade_streams ORDER BY peer,direction,source,incarnation,stream',
      )
    ) {
      const scope = String(row.stream);
      if (!selected(scope)) {
        continue;
      }
      const identity = [
        row.peer,
        row.direction,
        row.source,
        row.incarnation,
        row.stream,
      ];
      const membership = scope.startsWith('membership:');
      const membershipSource = membership
        ? await membershipBinding(conn, role, row)
        : null;
      const cut = async (
        sequence: number,
        hash: string,
      ): Promise<ProgressCut> => ({
        sequence,
        hash,
        sourceCut: await semanticCut(
          conn,
          identity,
          sequence,
          membership,
          membershipSource,
        ),
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
        ready = applied.sequence > 0 &&
          (!membership || membershipSource !== null);
      } else {
        // Scope completion is enrollment-bound in both directions. Reverse
        // journals instead carry the facade node incarnation; never mistake
        // that source identity for the enrollment that owns its applied scope.
        const enrollment = await scopeEnrollment(conn, role, row);
        const [held] = await conn.query(
          'SELECT ready,pending_hash FROM facade_scopes WHERE incarnation=? AND scope=?',
          [enrollment, row.stream],
        );
        ready = membership
          ? membershipSource !== null && applied.sourceCut !== null
          : held?.ready === 1 && held.pending_hash === null;
        if (ready) {
          published = applied;
        }
      }
      const [declared] = await conn.query(
        "SELECT c.value AS cut FROM facade_streams s JOIN facade_records r ON r.peer=s.peer AND r.direction=s.direction AND r.source=s.source AND r.incarnation=s.incarnation AND r.stream=s.stream AND r.sequence=s.applied JOIN json_each(json_extract(r.record_json,'$.payload.view.cuts')) c ON c.key=? WHERE s.peer=? AND s.direction='in' AND s.source=? AND s.incarnation=? AND s.stream='directory'",
        [scope, row.peer, row.source, row.incarnation],
      );
      if (membership && row.direction === 'in' && role === 'facade') {
        // Directory declarations use JOURNAL positions, never operation counters.
        // Convert that prefix through the same current-source semantic mapping.
        const position = Math.min(applied.sequence, Number(declared?.cut ?? 0));
        const [record] = position
          ? await conn.query(
            'SELECT hash FROM facade_records WHERE peer=? AND direction=? AND source=? AND incarnation=? AND stream=? AND sequence=?',
            [...identity, position] as (string | number)[],
          )
          : [];
        published = ready && record
          ? await cut(position, String(record.hash))
          : null;
      }
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

async function membershipBinding(
  conn: Conn,
  role: 'home' | 'facade',
  row: Record<string, unknown>,
): Promise<string | null> {
  const forward = row.source === 'home';
  const incoming = row.direction === 'in';
  if (
    forward !== (role === 'facade' ? incoming : !incoming) ||
    (incoming && row.peer !== row.source) ||
    (!incoming && !forward && row.peer !== 'home')
  ) return null;
  const bindings = await conn.query(
    "SELECT c.signed_json FROM facade_pairings p JOIN facade_owner_activation a ON a.pairing=p.id JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision WHERE p.side=? AND p.state='paired' AND " +
      (forward
        ? 'p.id=?' + (incoming ? '' : ' AND p.node=?')
        : "p.node=? AND json_extract(p.grant_json,'$.body.transcript.body.incarnation')=?"),
    forward
      ? [role, String(row.incarnation), ...incoming ? [] : [String(row.peer)]]
      : [role, String(row.source), String(row.incarnation)],
  );
  if (bindings.length !== 1) return null;
  const body = JSON.parse(String(bindings[0].signed_json)).body;
  const source = (body.nodes as { node: string; incarnation: string }[]).find((
    source,
  ) => source.node === row.source);
  return source?.incarnation ?? null;
}

async function scopeEnrollment(
  conn: Conn,
  role: 'home' | 'facade',
  row: Record<string, unknown>,
): Promise<string | null> {
  if (role === 'facade') {
    return row.peer === 'home' && row.source === 'home'
      ? String(row.incarnation)
      : null;
  }
  if (row.peer !== row.source || row.source === 'home') return null;
  const bindings = await conn.query(
    "SELECT id FROM facade_pairings WHERE side='home' AND state='paired' AND node=? AND json_extract(grant_json,'$.body.transcript.body.incarnation')=?",
    [String(row.source), String(row.incarnation)],
  );
  return bindings.length === 1 ? String(bindings[0].id) : null;
}

async function semanticCut(
  conn: Conn,
  identity: unknown[],
  sequence: number,
  membership = false,
  sourceIncarnation: string | null = null,
): Promise<number | null> {
  if (!sequence) return null;
  if (membership) {
    if (sourceIncarnation === null) return null;
    const [row] = await conn.query(
      "SELECT MAX(json_extract(record_json,'$.payload.body.operation.sequence')) AS cut FROM facade_records WHERE peer=? AND direction=? AND source=? AND incarnation=? AND stream=? AND sequence<=? AND json_extract(record_json,'$.payload.body.kind')='membership-operation' AND json_extract(record_json,'$.payload.body.source')=source AND json_extract(record_json,'$.payload.body.incarnation')=? AND json_extract(record_json,'$.payload.body.operation.source')=source AND json_extract(record_json,'$.payload.body.operation.incarnation')=?",
      [
        ...identity,
        sequence,
        sourceIncarnation,
        sourceIncarnation,
      ] as (string | number)[],
    );
    return typeof row?.cut === 'number' ? row.cut : null;
  }
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
