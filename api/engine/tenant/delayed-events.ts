// Durable commands and signed submission receipts. All effects use one tenant
// connection; room authorization and writes are composed outside this module.
import type { Conn } from '#engine/store/db.ts';
import type { Row } from '#engine/store/ffi.ts';
import type { Pdu } from '#engine/pdu.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { DeviceIdentity } from './devices.ts';
import type { PreparedSubmission } from '#engine/room/ingest.ts';
import type { Standing } from '#engine/room/events.ts';
import { Buffer } from 'node:buffer';
import {
  importRegisterOperation,
  readRegister,
  registerJson,
  type RegisterOperation,
  registerOperations,
  writeRegister,
} from '#engine/facade/registers.ts';
import { ownerUnavailable, tenantAuthority } from './session-authority.ts';
import type { DomainHistoryProof } from '#engine/facade/domain-control.ts';
import { requireTenantDomainSource } from './domain-source.ts';

function ownerPrefix(node: string, incarnation: string): string {
  return 'd.' +
    Buffer.from(JSON.stringify([node, incarnation])).toString('base64url') +
    '.';
}

/** Legacy bearer IDs predate enrollment and belong to home. An opaque ID is a
 * routing hint only: current tenant authority, never the hint, permits writes. */
export async function requireOwner(conn: Conn, id: string): Promise<void> {
  const authority = await tenantAuthority(conn);
  if (!authority) return;
  if (id.startsWith('d.')) {
    if (!id.startsWith(ownerPrefix(authority.node, authority.incarnation))) {
      ownerUnavailable();
    }
  } else if (authority.node !== 'home') ownerUnavailable();
}

export async function newId(conn: Conn): Promise<string> {
  const authority = await tenantAuthority(conn);
  return (authority ? ownerPrefix(authority.node, authority.incarnation) : '') +
    crypto.randomUUID();
}

/** A restored enrolled store cannot prove that a pending command did not run
 * after its backup cut. Keep its evidence and receipts, but never resume it
 * from that old row alone. Original terminal imports retire it without echo.
 * Ordinary restart never invokes this private-candidate sanitation boundary. */
export async function quarantineRestoredSchedules(conn: Conn): Promise<number> {
  if (!await tenantAuthority(conn)) return 0;
  return await conn.execute(
    "UPDATE delayed_events SET phase='quarantined' WHERE phase!='quarantined'",
  );
}

export function requireUnfenced(phase: string): void {
  if (phase === 'quarantined') {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      'restored delayed event requires reconciliation',
    );
  }
}

function semanticKey(localpart: string, id: string): string {
  return JSON.stringify(['delayed-event', localpart, id]);
}

export async function operations(
  conn: Conn,
  localpart: string,
): Promise<RegisterOperation[]> {
  const keys = await conn.query(
    "SELECT DISTINCT semantic_key FROM domain_operations WHERE kind='delayed-event' AND json_extract(semantic_key,'$[1]')=? ORDER BY semantic_key",
    [localpart],
  );
  const result: RegisterOperation[] = [];
  for (const row of keys) {
    result.push(...await registerOperations(conn, String(row.semantic_key)));
  }
  return result;
}

/** Original schedule/submission/receipt evidence commits with every native
 * transition. The journal retains terminal facts after executable rows vanish.
 * Foreign copies will remain journal facts, never scheduler rows. */
async function retain(
  conn: Conn,
  id: string,
  terminal?: 'cancelled' | 'completed',
  standing: Standing | null = null,
): Promise<void> {
  const authority = await tenantAuthority(conn);
  if (!authority) return;
  await requireOwner(conn, id);
  const [row] = await conn.query('SELECT * FROM delayed_events WHERE id=?', [
    id,
  ]);
  if (!row) return;
  requireUnfenced(String(row.phase));
  const key = semanticKey(String(row.localpart), id);
  const before = await readRegister(conn, key);
  const phase = terminal ?? String(row.phase);
  const payload = registerJson(JSON.stringify({
    event: { ...eventOf(row), phase },
    eventId: row.event_id,
    pdu: row.pending_pdu === null ? null : JSON.parse(String(row.pending_pdu)),
    completed: row.completed === 1,
    // Completion bookkeeping alone does not distinguish accepted/soft-failed/
    // rejected room outcomes. Only the actual ingest result may supply this.
    standing,
    receipts: await conn.query(
      'SELECT localpart,device_id,generation,endpoint,txn_id FROM delayed_event_receipts WHERE delay_id=? ORDER BY localpart,device_id,generation,endpoint,txn_id',
      [id],
    ),
  }));
  if (before.winner?.payload === payload) return;
  if (before.winner) {
    const old = JSON.parse(before.winner.payload).event.phase;
    if (old === 'cancelled' || old === 'completed') {
      throw new Error('delayed event is terminal');
    }
  }
  await writeRegister(
    conn,
    { source: authority.node, incarnation: authority.incarnation },
    key,
    'delayed-event',
    payload,
  );
}

export async function captureOperations(conn: Conn, localpart: string) {
  const authority = await tenantAuthority(conn);
  if (authority?.node !== 'home') {
    throw new Error('delayed bootstrap requires home authority');
  }
  for (
    const row of await conn.query(
      'SELECT id FROM delayed_events WHERE localpart=? ORDER BY id',
      [localpart],
    )
  ) {
    const id = String(row.id);
    if ((await registerOperations(conn, semanticKey(localpart, id))).length) {
      continue;
    }
    // Only legacy home rows may lack their atomic source fact. Never recreate
    // another incarnation's authorship from a materialized executable row.
    if (id.startsWith('d.')) throw new Error('delayed source fact unavailable');
    await retain(conn, id);
  }
  return await operations(conn, localpart);
}

function factOf(
  operation: RegisterOperation,
): {
  event: DelayedEvent;
  eventId: string | null;
  pdu: Pdu | null;
  completed: boolean;
  standing: Standing | null;
  receipts: Record<string, unknown>[];
} {
  const bad = () => {
    throw new Error('invalid delayed event operation');
  };
  let key, body;
  try {
    key = JSON.parse(operation.semanticKey);
    body = JSON.parse(operation.payload);
  } catch {
    return bad();
  }
  if (
    !Array.isArray(key) || key.length !== 3 || key[0] !== 'delayed-event' ||
    typeof key[1] !== 'string' || !key[1] || typeof key[2] !== 'string' ||
    !key[2] ||
    operation.semanticKey !== semanticKey(key[1], key[2]) ||
    operation.kind !== 'delayed-event' ||
    !body || typeof body !== 'object' || Array.isArray(body)
  ) return bad();
  const e = body.event;
  if (
    !e || typeof e !== 'object' || Array.isArray(e) || e.id !== key[2] ||
    e.localpart !== key[1] ||
    typeof e.roomId !== 'string' || !e.roomId.startsWith('!') ||
    typeof e.type !== 'string' || !e.type ||
    !(e.stateKey === null || typeof e.stateKey === 'string') ||
    !e.content || typeof e.content !== 'object' || Array.isArray(e.content) ||
    ![e.delay, e.since, e.due, e.roomPos].every((n) =>
      Number.isSafeInteger(n) && n >= 0
    ) ||
    !(e.stateEvent === null || typeof e.stateEvent === 'string') ||
    !['pending', 'sending', 'cancelled', 'completed'].includes(e.phase) ||
    !(body.eventId === null || typeof body.eventId === 'string') ||
    !(body.pdu === null ||
      (typeof body.pdu === 'object' && !Array.isArray(body.pdu) &&
        body.pdu.event_id === body.eventId && body.pdu.room_id === e.roomId)) ||
    typeof body.completed !== 'boolean' ||
    (body.completed && (body.eventId === null || body.pdu !== null)) ||
    (e.phase === 'completed' && !body.completed) ||
    !(body.standing === null ||
      ['accepted', 'soft_failed', 'rejected'].includes(body.standing)) ||
    (body.standing !== null && e.phase !== 'completed') ||
    !Array.isArray(body.receipts) ||
    body.receipts.some((r: Record<string, unknown>) =>
      !r || r.localpart !== key[1] || typeof r.device_id !== 'string' ||
      !Number.isSafeInteger(r.generation) || Number(r.generation) < 1 ||
      typeof r.endpoint !== 'string' || typeof r.txn_id !== 'string'
    )
  ) return bad();
  if (
    e.id.startsWith('d.')
      ? !e.id.startsWith(ownerPrefix(operation.source, operation.incarnation))
      : operation.source !== 'home'
  ) return bad();
  // One issuer owns this schedule's entire history. The register is retention
  // and dependency tracking here, not multiwriter winner arbitration.
  if (
    !Array.isArray(operation.context) ||
    (operation.sequence === 1
      ? operation.context.length !== 0
      : operation.context.length !== 1 ||
        operation.context[0].source !== operation.source ||
        operation.context[0].incarnation !== operation.incarnation ||
        operation.context[0].sequence !== operation.sequence - 1)
  ) return bad();
  return body;
}

export async function importOperation(
  conn: Conn,
  operation: RegisterOperation,
  history?: DomainHistoryProof,
) {
  const fact = factOf(operation);
  await requireTenantDomainSource(
    conn,
    operation,
    fact.event.localpart,
    history,
  );
  await importRegisterOperation(conn, operation);
  const all = await registerOperations(conn, operation.semanticKey);
  let terminal = false;
  let immutable: string | undefined;
  let prepared: ReturnType<typeof factOf> | undefined;
  for (const retained of all) {
    const current = factOf(retained);
    const e = current.event;
    const command = registerJson(JSON.stringify([
      e.id,
      e.localpart,
      e.roomId,
      e.type,
      e.stateKey,
      e.content,
      e.delay,
      e.roomPos,
      e.stateEvent,
      current.receipts,
    ]));
    if (
      retained.source !== operation.source ||
      retained.incarnation !== operation.incarnation || terminal ||
      (immutable !== undefined && immutable !== command) ||
      (prepared && (current.eventId !== prepared.eventId ||
        (prepared.completed && !current.completed) ||
        (prepared.pdu !== null && current.pdu !== null &&
          registerJson(JSON.stringify(prepared.pdu)) !==
            registerJson(JSON.stringify(current.pdu)))))
    ) {
      throw new Error(
        'delayed event is terminal or its original command changed',
      );
    }
    immutable = command;
    if (current.eventId !== null) prepared = current;
    terminal = ['cancelled', 'completed'].includes(current.event.phase);
  }
  if (terminal) {
    // An original local terminal fact also fences a stale executable backup.
    // This retirement is a projection, never a new authored transition.
    await conn.execute('DELETE FROM delayed_events WHERE id=?', [
      fact.event.id,
    ]);
  }
}

/** Protected replicas are account-wide read evidence only. Do not open their
 * rooms, interpret roomPos locally, install receipts or create executable jobs. */
export async function replicas(
  conn: Conn,
  localpart: string,
): Promise<DelayedEvent[]> {
  const [user] = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [localpart],
  );
  if (!user || user.deactivated === 1) return [];
  const executable = new Set(
    (await conn.query('SELECT id FROM delayed_events WHERE localpart=?', [
      localpart,
    ])).map((r) => String(r.id)),
  );
  const all = await operations(conn, localpart);
  const groups = new Map<string, RegisterOperation[]>();
  for (const op of all) {
    const rows = groups.get(op.semanticKey) ?? [];
    rows.push(op);
    groups.set(op.semanticKey, rows);
  }
  const result: DelayedEvent[] = [];
  for (const [key, rows] of groups) {
    // Authenticated cancellation/completion cannot be resurrected by a replayed
    // predecessor, even while its other predecessors are still in flight.
    if (
      rows.some((op) =>
        ['cancelled', 'completed'].includes(factOf(op).event.phase)
      )
    ) continue;
    const view = await readRegister(conn, key);
    if (!view.winner || view.pending.length) continue;
    const fact = factOf(view.winner);
    if (fact.event.phase === 'pending' && !executable.has(fact.event.id)) {
      result.push(fact.event);
    }
  }
  return result.sort((a, b) =>
    a.due - b.due || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

async function localRows(conn: Conn, rows: Row[]): Promise<Row[]> {
  const authority = await tenantAuthority(conn);
  if (!authority) return rows;
  const prefix = ownerPrefix(authority.node, authority.incarnation);
  return rows.filter((row) =>
    String(row.id).startsWith(prefix) ||
    (authority.node === 'home' && !String(row.id).startsWith('d.'))
  );
}

async function ownerSelection(conn: Conn) {
  const authority = await tenantAuthority(conn);
  if (!authority) return { sql: '1', params: [] as (string | number)[] };
  const prefix = ownerPrefix(authority.node, authority.incarnation);
  return {
    sql: "(substr(id,1,?)=? OR (?='home' AND substr(id,1,2)!='d.'))",
    params: [prefix.length, prefix, authority.node],
  };
}

export async function removeAll(conn: Conn, localpart: string): Promise<void> {
  for (const event of await list(conn, localpart)) {
    // The account tombstone itself retires ambiguous commands. Do not invent a
    // successor schedule fact from a rolled-back source sequence.
    if (event.phase !== 'quarantined') await remove(conn, event.id);
  }
  // Imported or old-incarnation rows are never local execution authority, but
  // account retirement must still clear any retained private materialization.
  await conn.execute('DELETE FROM delayed_events WHERE localpart=?', [
    localpart,
  ]);
}

export type DelayedEvent = {
  id: string;
  localpart: string;
  roomId: string;
  type: string;
  stateKey: string | null;
  content: Record<string, unknown>;
  delay: number;
  since: number;
  due: number;
  roomPos: number;
  stateEvent: string | null;
  phase: string;
};
export type DelayReceipt = {
  device: DeviceIdentity;
  endpoint: string;
  txnId: string;
};

function eventOf(r: Row): DelayedEvent {
  return {
    id: String(r.id),
    localpart: String(r.localpart),
    roomId: String(r.room_id),
    type: String(r.type),
    stateKey: r.state_key === null ? null : String(r.state_key),
    content: JSON.parse(String(r.content)),
    delay: Number(r.delay_ms),
    since: Number(r.since_ms),
    due: Number(r.due_ms),
    roomPos: Number(r.room_pos),
    stateEvent: r.state_event === null ? null : String(r.state_event),
    phase: String(r.phase),
  };
}
export function notFound(): never {
  throw new MatrixError(404, 'M_NOT_FOUND', 'no matching delayed event');
}
export async function get(
  conn: Conn,
  id: string,
): Promise<DelayedEvent | null> {
  await requireOwner(conn, id);
  const rows = await conn.query('SELECT * FROM delayed_events WHERE id=?', [
    id,
  ]);
  return rows.length ? eventOf(rows[0]) : null;
}
export async function list(
  conn: Conn,
  localpart: string,
): Promise<DelayedEvent[]> {
  return (await localRows(
    conn,
    await conn.query(
      'SELECT * FROM delayed_events WHERE localpart=? ORDER BY due_ms,id',
      [localpart],
    ),
  )).map(eventOf);
}
export async function receipt(
  conn: Conn,
  r: DelayReceipt,
): Promise<string | null> {
  const d = r.device;
  const rows = await conn.query(
    'SELECT delay_id FROM delayed_event_receipts WHERE localpart=? AND device_id=? AND generation=? AND endpoint=? AND txn_id=?',
    [d.localpart, d.deviceId, d.generation, r.endpoint, r.txnId],
  );
  if (!rows.length) return null;
  const id = String(rows[0].delay_id);
  await requireOwner(conn, id);
  return id;
}
export async function add(
  conn: Conn,
  event: DelayedEvent,
  limit: number,
  r?: DelayReceipt,
): Promise<string> {
  await requireOwner(conn, event.id);
  if (r) {
    const existing = await receipt(conn, r);
    if (existing !== null) return existing;
  }
  const account = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [event.localpart],
  );
  if (!account.length || account[0].deactivated !== 0) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'account inactive');
  }
  const count = await conn.query(
    'SELECT COUNT(*) AS n FROM delayed_events WHERE localpart=?',
    [event.localpart],
  );
  if (Number(count[0].n) >= limit) {
    throw new MatrixError(429, 'M_LIMIT_EXCEEDED', 'too many delayed events');
  }
  await conn.execute(
    'INSERT INTO delayed_events(id,localpart,room_id,type,state_key,content,delay_ms,since_ms,due_ms,room_pos,state_event) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [
      event.id,
      event.localpart,
      event.roomId,
      event.type,
      event.stateKey,
      canonicalJson(event.content),
      event.delay,
      event.since,
      event.due,
      event.roomPos,
      event.stateEvent,
    ],
  );
  if (r) {
    const d = r.device;
    await conn.execute(
      'INSERT INTO delayed_event_receipts(localpart,device_id,generation,endpoint,txn_id,delay_id) VALUES(?,?,?,?,?,?)',
      [d.localpart, d.deviceId, d.generation, r.endpoint, r.txnId, event.id],
    );
  }
  await retain(conn, event.id);
  return event.id;
}
export async function remove(
  conn: Conn,
  id: string,
  standing?: Standing,
): Promise<void> {
  await requireOwner(conn, id);
  const [row] = await conn.query(
    'SELECT completed FROM delayed_events WHERE id=?',
    [id],
  );
  await retain(
    conn,
    id,
    row?.completed === 1 ? 'completed' : 'cancelled',
    standing,
  );
  await conn.execute('DELETE FROM delayed_events WHERE id=?', [id]);
}
export async function action(
  conn: Conn,
  id: string,
  action: 'cancel' | 'restart' | 'send',
  now: number,
): Promise<void> {
  const event = await get(conn, id);
  if (event === null) notFound();
  requireUnfenced(event.phase);
  if (event.phase !== 'pending') notFound();
  if (action === 'cancel') return await remove(conn, id);
  await retain(conn, id);
  await conn.execute(
    "UPDATE delayed_events SET since_ms=?,due_ms=? WHERE id=? AND phase='pending'",
    [
      action === 'restart' ? now : event.since,
      action === 'restart' ? now + event.delay : now,
      id,
    ],
  );
  await retain(conn, id);
}
export async function next(conn: Conn): Promise<number | null> {
  const owner = await ownerSelection(conn);
  const [row] = await conn.query(
    "SELECT MIN(due_ms) AS n FROM delayed_events WHERE phase IN ('pending','sending') AND " +
      owner.sql,
    owner.params,
  );
  return row.n === null ? null : Number(row.n);
}
export async function retry(
  conn: Conn,
  ids: readonly string[],
  due: number,
): Promise<void> {
  if (ids.length === 0) return;
  for (const id of ids) {
    await requireOwner(conn, id);
    await retain(conn, id);
  }
  await conn.execute(
    `UPDATE delayed_events SET due_ms=? WHERE phase='sending' AND id IN (${
      ids.map(() => '?').join(',')
    })`,
    [due, ...ids],
  );
  for (const id of ids) await retain(conn, id);
}
export async function due(conn: Conn, now: number): Promise<DelayedEvent[]> {
  const owner = await ownerSelection(conn);
  return (await conn.query(
    "SELECT * FROM delayed_events WHERE phase IN ('pending','sending') AND due_ms<=? AND " +
      owner.sql +
      ' ORDER BY due_ms,id LIMIT 32',
    [now, ...owner.params],
  )).map(eventOf);
}
export async function claim(
  conn: Conn,
  id: string,
  now: number,
): Promise<DelayedEvent | null> {
  const event = await get(conn, id);
  // Selection is only a hint. A concurrent heartbeat may have restarted the
  // deadline before this transaction acquired the command.
  if (
    event === null || event.due > now ||
    !['pending', 'sending'].includes(event.phase)
  ) return null;
  await retain(conn, id);
  await conn.execute(
    "UPDATE delayed_events SET phase='sending' WHERE id=? AND phase!='sending'",
    [
      id,
    ],
  );
  await retain(conn, id);
  return event;
}
export async function submission(
  conn: Conn,
  id: string,
): Promise<PreparedSubmission | null> {
  await requireOwner(conn, id);
  const rows = await conn.query(
    'SELECT event_id,pending_pdu FROM delayed_events WHERE id=?',
    [id],
  );
  if (!rows.length || rows[0].event_id === null) return null;
  return {
    eventId: String(rows[0].event_id),
    pdu: rows[0].pending_pdu === null
      ? null
      : JSON.parse(String(rows[0].pending_pdu)),
  };
}
export async function prepare(
  conn: Conn,
  id: string,
  pdu: Pdu,
): Promise<PreparedSubmission> {
  await requireOwner(conn, id);
  await retain(conn, id);
  await conn.execute(
    'UPDATE delayed_events SET event_id=?,pending_pdu=? WHERE id=? AND event_id IS NULL',
    [String(pdu.event_id), canonicalJson(pdu), id],
  );
  const result = await submission(conn, id);
  if (result === null) throw new Error('E_DELAYED_SUBMISSION_MISSING');
  await retain(conn, id);
  return result;
}
export async function finish(conn: Conn, id: string): Promise<void> {
  await requireOwner(conn, id);
  await retain(conn, id);
  await conn.execute(
    'UPDATE delayed_events SET completed=1,pending_pdu=NULL WHERE id=? AND (completed!=1 OR pending_pdu IS NOT NULL)',
    [id],
  );
  await retain(conn, id);
}
