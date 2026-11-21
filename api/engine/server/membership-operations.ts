// OOB lifecycle source facts commit with their owning transition, before a later
// display replacement can erase them. They are NOT room-DAG/register winners,
// imported stream positions or permission for another node to dispatch attempts.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { domainOf } from '#engine/ids.ts';
import type { Conn } from '#engine/store/db.ts';
import type { RegisterDot } from '#engine/facade/registers.ts';

export type MembershipState = {
  roomId: string;
  userId: string;
  eventId: string;
  roomVersion: string;
  eventJson: string;
  inviteRoomState: string;
  origin: string;
  status: string;
  kind: 'invite' | 'knock';
  localLeaveJson: string | null;
  // Relationship at this source admission, never foreign publication numbers.
  publication: { eventId: string; membership: string; follows: boolean } | null;
};

export type MembershipOperation = RegisterDot & {
  operationId: string;
  stream: string;
  semanticKey: string;
  kind: 'membership';
  context: RegisterDot[];
  payloadHash: string;
  payload: string;
};

/** Membership sequences allocate identities, not causal source prefixes. A
 * prepared completion may branch behind a newer observation of that source. */
export function membershipContext(dots: readonly RegisterDot[]): RegisterDot[] {
  return dots.map(({ source, incarnation, sequence }) => ({
    source,
    incarnation,
    sequence,
  })).sort((a, b) => {
    const left = canonicalJson([a.source, a.incarnation]);
    const right = canonicalJson([b.source, b.incarnation]);
    return left < right ? -1 : left > right ? 1 : a.sequence - b.sequence;
  });
}

/** The display owner's normalized local value, without publication authority. */
export function membershipStateOf(
  row: Record<string, unknown>,
): Omit<MembershipState, 'publication'> {
  return {
    roomId: String(row.room_id),
    userId: String(row.user_id),
    eventId: String(row.event_id),
    roomVersion: String(row.room_version),
    eventJson: canonicalJson(JSON.parse(String(row.event_json))),
    inviteRoomState: canonicalJson(JSON.parse(String(row.invite_room_state))),
    origin: String(row.origin),
    status: String(row.status),
    kind: String(row.kind) as MembershipState['kind'],
    localLeaveJson: row.local_leave_json == null
      ? null
      : canonicalJson(JSON.parse(String(row.local_leave_json))),
  };
}

function fromRow(row: Record<string, unknown>): MembershipOperation {
  return {
    operationId: String(row.operation_id),
    source: String(row.source),
    incarnation: String(row.incarnation),
    sequence: Number(row.sequence),
    stream: String(row.stream),
    semanticKey: String(row.semantic_key),
    kind: 'membership',
    context: JSON.parse(String(row.context_json)),
    payloadHash: String(row.payload_hash),
    payload: String(row.payload_json),
  };
}

export async function membershipOperations(
  conn: Conn,
  userId: string,
  after?: RegisterDot,
) {
  return (await conn.query(
    "SELECT * FROM domain_operations WHERE kind='membership' AND json_extract(payload_json,'$.userId')=?" +
      (after ? ' AND source=? AND incarnation=? AND sequence>?' : '') +
      ' ORDER BY source,incarnation,sequence',
    after
      ? [userId, after.source, after.incarnation, after.sequence]
      : [userId],
  )).map(fromRow);
}

/** Source knowledge and display eligibility share the same transitive closure.
 * A retained but incomplete import is evidence, not observed causal knowledge. */
export function completeMembershipHistory(all: MembershipOperation[]) {
  const identity = (dot: RegisterDot, stream: string) =>
    canonicalJson([dot.source, dot.incarnation, stream, dot.sequence]);
  const ready = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const operation of all) {
      if (
        ready.has(operation.operationId) ||
        !operation.context.every((dot) =>
          ready.has(identity(dot, operation.stream))
        )
      ) continue;
      ready.add(operation.operationId);
      changed = true;
    }
  }
  const complete = all.filter((operation) => ready.has(operation.operationId));
  const observed = new Set(
    complete.flatMap((operation) =>
      operation.context.map((dot) => identity(dot, operation.stream))
    ),
  );
  return {
    ready: complete,
    pending: all.filter((operation) => !ready.has(operation.operationId)),
    frontier: complete.filter((operation) =>
      !observed.has(operation.operationId)
    ),
  };
}

/** Use this SAME Conn before and after a local lifecycle mutation. No-op retries
 * retain their identity; failed mutations roll back facts and counters together.
 * F1/standalone and foreign Matrix accounts have no semantic source authority. */
export async function recordMembershipOperation(
  conn: Conn,
  roomId: string,
  userId: string,
) {
  const [control] = await conn.query(
    'SELECT c.signed_json,p.node FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision CROSS JOIN publication_domain p WHERE p.singleton=1',
  );
  if (!control) return;
  const body = JSON.parse(String(control.signed_json)).body;
  if (domainOf(userId) !== body.server) return;
  const source = (body.nodes as { node: string; incarnation: string }[])
    .find((source) => source.node === control.node);
  if (!source) throw new Error('membership source unavailable');
  const [row] = await conn.query(
    'SELECT * FROM prejoin_memberships WHERE room_id=? AND user_id=?',
    [roomId, userId],
  );
  if (!row) return;
  const state = membershipStateOf(row);
  const semanticKey = canonicalJson(['membership', roomId, userId]);
  const stream = 'membership:' + userId;
  const retained = (await conn.query(
    "SELECT * FROM domain_operations WHERE kind='membership' AND semantic_key=? ORDER BY source,incarnation,sequence",
    [semanticKey],
  )).map(fromRow);
  const history = completeMembershipHistory(retained);
  const selected = await conn.query(
    "SELECT o.operation_id,o.payload_json FROM domain_frontiers f JOIN domain_operations o ON o.operation_id=f.operation_id WHERE f.semantic_key=? AND o.kind='membership' ORDER BY o.operation_id",
    [semanticKey],
  );
  if (row.source_binding != null) {
    const binding = JSON.parse(String(row.source_binding));
    if (canonicalJson(binding.state) === canonicalJson(state)) {
      const ids = selected.map((operation) => String(operation.operation_id));
      const complete = new Set(
        history.ready.map((operation) => operation.operationId),
      );
      if (
        !ids.length ||
        canonicalJson(ids) !== canonicalJson(binding.operations) ||
        ids.some((id) => !complete.has(id))
      ) {
        throw new Error('membership display binding unavailable');
      }
      return;
    }
  }
  // This reference belongs to the membership display owner, not a register
  // winner. A foreign operation already selected by that owner stays foreign;
  // capturing the old value before our successor must never re-author it.
  if (selected.length === 1) {
    const { publication: _publication, ...prior } = JSON.parse(
      String(selected[0].payload_json),
    ) as MembershipState;
    if (canonicalJson(prior) === canonicalJson(state)) return;
  }
  const [published] = await conn.query(
    'SELECT event,membership,seq FROM memberships WHERE room=? AND user=?',
    [roomId, userId],
  );
  const payload = canonicalJson(
    {
      ...state,
      publication: published
        ? {
          eventId: String(published.event),
          membership: String(published.membership),
          follows: Number(row.seq) > Number(published.seq),
        }
        : null,
    } satisfies MembershipState,
  );
  const own = new Set(
    history.ready.filter((operation) =>
      operation.source === source.node &&
      operation.incarnation === source.incarnation
    ).map((operation) => operation.sequence),
  );
  if (
    retained.some((operation) =>
      operation.context.some((dot) =>
        dot.source === source.node && dot.incarnation === source.incarnation &&
        !own.has(dot.sequence)
      )
    )
  ) throw new Error('local membership predecessor unavailable');
  // Capture every observed branch, including distinct dots of the same source.
  // Prepared completions do not make a source sequence a causal prefix.
  const operation = await appendMembershipFact(
    conn,
    { source: source.node, incarnation: source.incarnation },
    stream,
    semanticKey,
    payload,
    membershipContext(history.frontier),
  );
  await conn.execute('DELETE FROM domain_frontiers WHERE semantic_key=?', [
    semanticKey,
  ]);
  await conn.execute(
    'INSERT INTO domain_frontiers(semantic_key,operation_id) VALUES(?,?)',
    [semanticKey, operation.operationId],
  );
  await conn.execute(
    'UPDATE prejoin_memberships SET source_binding=NULL WHERE room_id=? AND user_id=?',
    [roomId, userId],
  );
}

/** Complete exact prepared work using its source cut, never current display.
 * Allocating a later source sequence does not observe newly imported facts. */
export async function appendMembershipSuccessor(
  conn: Conn,
  prior: MembershipOperation,
  state: MembershipState,
): Promise<MembershipOperation> {
  if (
    prior.semanticKey !==
      canonicalJson(['membership', state.roomId, state.userId])
  ) throw new Error('membership successor changed identity');
  return await appendMembershipFact(
    conn,
    prior,
    prior.stream,
    prior.semanticKey,
    canonicalJson(state),
    membershipContext([prior]),
  );
}

async function appendMembershipFact(
  conn: Conn,
  source: Pick<MembershipOperation, 'source' | 'incarnation'>,
  stream: string,
  semanticKey: string,
  payload: string,
  context: RegisterDot[],
): Promise<MembershipOperation> {
  const counter = 'domain:' +
    canonicalJson([source.source, source.incarnation, stream]);
  const [observed] = await conn.query(
    "SELECT MAX(sequence) AS sequence FROM domain_operations WHERE kind='membership' AND source=? AND incarnation=? AND stream=?",
    [source.source, source.incarnation, stream],
  );
  await conn.execute(
    'INSERT INTO counters(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=MAX(value,excluded.value)',
    [counter, Number(observed?.sequence ?? 0)],
  );
  await conn.execute('UPDATE counters SET value=value+1 WHERE name=?', [
    counter,
  ]);
  const [allocated] = await conn.query(
    'SELECT value FROM counters WHERE name=?',
    [counter],
  );
  const sequence = Number(allocated.value);
  const operationId = canonicalJson([
    source.source,
    source.incarnation,
    stream,
    sequence,
  ]);
  await conn.execute(
    'INSERT INTO domain_operations(operation_id,source,incarnation,stream,sequence,semantic_key,kind,context_json,payload_hash,payload_json,applied) VALUES(?,?,?,?,?,?,?,?,?,?,1)',
    [
      operationId,
      source.source,
      source.incarnation,
      stream,
      sequence,
      semanticKey,
      'membership',
      canonicalJson(context),
      createHash('sha256').update(payload).digest('hex'),
      payload,
    ],
  );
  return {
    ...source,
    source: source.source,
    incarnation: source.incarnation,
    sequence,
    operationId,
    stream,
    semanticKey,
    kind: 'membership',
    context,
    payloadHash: createHash('sha256').update(payload).digest('hex'),
    payload,
  };
}
