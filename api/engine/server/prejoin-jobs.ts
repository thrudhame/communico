// Local delivery truth is independent of the currently selected OOB display.
// Only the local lifecycle admission owner creates work, never link import.
import { canonicalJson } from '#engine/canonical.ts';
import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import { nextEventSeq } from './stream.ts';
import { visiblePrejoin } from './prejoin.ts';
import {
  appendMembershipSuccessor,
  type MembershipOperation,
  type MembershipState,
  recordMembershipOperation,
} from './membership-operations.ts';

export type PrejoinWork = {
  kind: 'invite' | 'knock';
  revision: number;
  candidates: string[];
  expiresMs: number | null;
  leaveJson: string | null;
  localLeaveJson: string | null;
  roomId: string;
  userId: string;
  eventId: string;
  roomVersion: string;
  eventJson: string;
  inviteRoomState: string;
  origin: string;
  receivedMs: number;
  status: string;
  seq: number;
};

export type PrejoinJob = {
  id: string;
  work: PrejoinWork;
  source: MembershipOperation | null;
};

const performing = new WeakMap<Store, Set<string>>();
export function beginPrejoinJob(store: Store, work: PrejoinWork) {
  let active = performing.get(store);
  if (!active) performing.set(store, active = new Set());
  const key = canonicalJson([work.roomId, work.userId]);
  if (active.has(key)) return null;
  active.add(key);
  return () => active.delete(key);
}

export const PREJOIN_JOBS_SQL = `
CREATE TABLE prejoin_jobs(job_id TEXT PRIMARY KEY NOT NULL,room_id TEXT NOT NULL,user_id TEXT NOT NULL,event_id TEXT NOT NULL,action TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,work_json TEXT NOT NULL,source_json TEXT,added_ms INTEGER NOT NULL,expires_ms INTEGER);
CREATE INDEX prejoin_jobs_pending ON prejoin_jobs(status,added_ms);
CREATE INDEX prejoin_jobs_member ON prejoin_jobs(room_id,user_id);
`;

export function prejoinWorkOf(row: Record<string, unknown>): PrejoinWork {
  return {
    kind: row.kind as PrejoinWork['kind'],
    revision: Number(row.revision),
    candidates: JSON.parse(String(row.candidates)),
    expiresMs: row.expires_ms == null ? null : Number(row.expires_ms),
    leaveJson: row.leave_json == null ? null : String(row.leave_json),
    localLeaveJson: row.local_leave_json == null
      ? null
      : String(row.local_leave_json),
    roomId: String(row.room_id),
    userId: String(row.user_id),
    eventId: String(row.event_id),
    roomVersion: String(row.room_version),
    eventJson: String(row.event_json),
    inviteRoomState: String(row.invite_room_state),
    origin: String(row.origin),
    receivedMs: Number(row.received_ms),
    status: String(row.status),
    seq: Number(row.seq),
  };
}

/** Upgrade only the old local lifecycle journal. A foreign selected display
 * never grants work ownership, including on an installation upgraded later. */
export async function migratePrejoinJobs(conn: Conn) {
  for (
    const row of await conn.query(
      "SELECT * FROM prejoin_memberships WHERE status IN ('attempting','failed-attempt','rejecting','failed-retract') AND source_binding IS NULL",
    )
  ) {
    await recordMembershipOperation(
      conn,
      String(row.room_id),
      String(row.user_id),
    );
    await createPrejoinJob(conn, prejoinWorkOf(row));
  }
}

export function prejoinJobId(work: PrejoinWork) {
  return canonicalJson([
    work.roomId,
    work.userId,
    work.eventId,
    work.status.includes('attempt') ||
      (work.kind === 'knock' && work.status === 'pending')
      ? 'knock'
      : 'leave',
  ]);
}

function decode(row: Record<string, unknown>): PrejoinJob {
  return {
    id: String(row.job_id),
    work: {
      ...JSON.parse(String(row.work_json)),
      status: String(row.status),
      revision: Number(row.revision),
    },
    source: row.source_json == null
      ? null
      : JSON.parse(String(row.source_json)),
  };
}

export async function prejoinJobs(
  conn: Pick<Conn, 'query'>,
  member?: { room: string; user: string },
) {
  return (await conn.query(
    "SELECT * FROM prejoin_jobs WHERE status IN ('attempting','failed-attempt','rejecting','failed-retract')" +
      (member ? ' AND room_id=? AND user_id=?' : '') +
      ' ORDER BY added_ms,job_id',
    member ? [member.room, member.user] : [],
  )).map(decode);
}

export async function prejoinJob(conn: Pick<Conn, 'query'>, id: string) {
  const [row] = await conn.query('SELECT * FROM prejoin_jobs WHERE job_id=?', [
    id,
  ]);
  return row ? decode(row) : null;
}

/** Called after the same transaction recorded the local admission source fact. */
export async function createPrejoinJob(
  conn: Conn,
  work: PrejoinWork,
  preparedSource?: MembershipOperation | null,
) {
  const id = prejoinJobId(work);
  if (await prejoinJob(conn, id)) return id;
  const [selected] = preparedSource === undefined
    ? await conn.query(
      "SELECT o.* FROM domain_frontiers f JOIN domain_operations o ON o.operation_id=f.operation_id CROSS JOIN publication_domain p WHERE f.semantic_key=? AND o.kind='membership' AND o.source=p.node AND p.singleton=1",
      [canonicalJson(['membership', work.roomId, work.userId])],
    )
    : [];
  let source: MembershipOperation | null = preparedSource ?? null;
  if (selected) {
    const state = JSON.parse(String(selected.payload_json)) as MembershipState;
    if (state.eventId !== work.eventId || state.status !== work.status) {
      throw new Error('prejoin work differs from local admission');
    }
    source = {
      operationId: String(selected.operation_id),
      source: String(selected.source),
      incarnation: String(selected.incarnation),
      sequence: Number(selected.sequence),
      stream: String(selected.stream),
      semanticKey: String(selected.semantic_key),
      kind: 'membership',
      context: JSON.parse(String(selected.context_json)),
      payloadHash: String(selected.payload_hash),
      payload: String(selected.payload_json),
    };
  } else if (preparedSource === undefined) {
    const [active] = await conn.query(
      'SELECT 1 FROM facade_owner_activation',
    );
    if (active) throw new Error('prejoin local source unavailable');
  }
  await conn.execute(
    'INSERT INTO prejoin_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [
      id,
      work.roomId,
      work.userId,
      work.eventId,
      work.status.includes('attempt') ? 'knock' : 'leave',
      work.status,
      work.revision,
      canonicalJson(work),
      source === null ? null : canonicalJson(source),
      work.receivedMs,
      work.expiresMs,
    ],
  );
  return id;
}

/** A locally observed invitation causally supersedes our old knock attempt.
 * Foreign display application must never call this local admission operation. */
export async function supersedePrejoinKnocks(
  conn: Conn,
  room: string,
  user: string,
) {
  await conn.execute(
    "UPDATE prejoin_jobs SET status='superseded' WHERE room_id=? AND user_id=? AND action='knock' AND status IN ('attempting','failed-attempt')",
    [room, user],
  );
}

export async function retractPrejoinKnock(
  conn: Conn,
  job: PrejoinJob,
  expires: number,
) {
  const changed = await updatePrejoinJob(conn, job, {
    ...job.work,
    status: 'rejecting',
    revision: job.work.revision + 1,
    expiresMs: expires,
  }, true);
  if (!changed) return false;
  await createPrejoinJob(conn, changed.work, changed.source);
  await conn.execute(
    "UPDATE prejoin_jobs SET status='superseded' WHERE job_id=?",
    [job.id],
  );
  return true;
}

/** A prepared job's source cut is immutable. Later display facts are not its
 * observations, and do not acquire or complete its remote side effect. */
export async function updatePrejoinJob(
  conn: Conn,
  job: PrejoinJob,
  next: PrejoinWork,
  semantic: boolean,
  publish = semantic,
) {
  const held = await prejoinJob(conn, job.id);
  const completing = semantic && held && (
    (next.status === 'rejected' && job.work.status === 'rejecting' &&
      held.work.status === 'failed-retract') ||
    (next.status === 'pending' && job.work.status === 'attempting' &&
      held.work.status === 'failed-attempt')
  );
  if (
    !held || held.work.revision !== job.work.revision ||
    (held.work.status !== job.work.status && !completing) ||
    held.work.eventId !== next.eventId ||
    held.work.roomId !== next.roomId || held.work.userId !== next.userId
  ) return null;
  const [display] = await conn.query(
    `SELECT *, (${
      visiblePrejoin('p')
    }) AS visible FROM prejoin_memberships p WHERE room_id=? AND user_id=? AND event_id=? AND revision=?`,
    [held.work.roomId, held.work.userId, held.work.eventId, held.work.revision],
  );
  const ownDisplay = display && (display.source_binding == null ||
    (held.source !== null &&
      (JSON.parse(String(display.source_binding)).operations as string[])
        .includes(held.source.operationId)));
  next = {
    ...next,
    seq: ownDisplay && publish && Number(display.visible) === 1
      ? await nextEventSeq(conn)
      : next.seq,
  };
  let source = held.source;
  if (semantic && source !== null) {
    const prior = JSON.parse(source.payload) as MembershipState;
    source = await appendMembershipSuccessor(conn, source, {
      ...prior,
      status: next.status,
      eventJson: canonicalJson(JSON.parse(next.eventJson)),
      inviteRoomState: canonicalJson(JSON.parse(next.inviteRoomState)),
      localLeaveJson: next.localLeaveJson === null
        ? null
        : canonicalJson(JSON.parse(next.localLeaveJson)),
    });
  }
  await conn.execute(
    'UPDATE prejoin_jobs SET status=?,revision=?,work_json=?,source_json=?,expires_ms=? WHERE job_id=?',
    [
      next.status,
      next.revision,
      canonicalJson(next),
      source === null ? null : canonicalJson(source),
      next.expiresMs,
      job.id,
    ],
  );
  if (ownDisplay) {
    await conn.execute(
      'UPDATE prejoin_memberships SET status=?,revision=?,event_json=?,invite_room_state=?,leave_json=?,local_leave_json=?,expires_ms=?,seq=? WHERE room_id=? AND user_id=? AND event_id=? AND revision=?',
      [
        next.status,
        next.revision,
        next.eventJson,
        next.inviteRoomState,
        next.leaveJson,
        next.localLeaveJson,
        next.expiresMs,
        next.seq,
        next.roomId,
        next.userId,
        next.eventId,
        held.work.revision,
      ],
    );
    if (source !== null && semantic) {
      await conn.execute('DELETE FROM domain_frontiers WHERE semantic_key=?', [
        source.semanticKey,
      ]);
      await conn.execute('INSERT INTO domain_frontiers VALUES(?,?)', [
        source.semanticKey,
        source.operationId,
      ]);
      await conn.execute(
        'UPDATE prejoin_memberships SET source_binding=NULL WHERE room_id=? AND user_id=?',
        [next.roomId, next.userId],
      );
    }
  }
  return { id: job.id, work: next, source } satisfies PrejoinJob;
}
