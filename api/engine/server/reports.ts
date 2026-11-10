// Reports are durable server-owned intent, not a projection of room events.
// Never persist event content or copy report reasons into logs or federation.
import type { Database } from '#engine/store/db.ts';
import type { Row } from '#engine/store/ffi.ts';
import { MatrixError } from '#engine/matrix-error.ts';

export type ReportKind = 'event' | 'room' | 'user';
export interface ReportInput {
  kind: ReportKind;
  reporter: string;
  roomId?: string;
  eventId?: string;
  userId?: string;
  reason?: string;
  score?: number;
}

export async function storeReport(db: Database, input: ReportInput) {
  const received = Date.now();
  await db.execute(
    'INSERT INTO reports(kind,reporter,room_id,event_id,user_id,reason,score,received_ms) VALUES(?,?,?,?,?,?,?,?)',
    [
      input.kind,
      input.reporter,
      input.roomId ?? null,
      input.eventId ?? null,
      input.userId ?? null,
      input.reason ?? null,
      input.score ?? null,
      received,
    ],
  );
}

function report(row: Row) {
  return {
    id: Number(row.id),
    kind: String(row.kind),
    reporter: String(row.reporter),
    roomId: row.room_id === null ? null : String(row.room_id),
    eventId: row.event_id === null ? null : String(row.event_id),
    userId: row.user_id === null ? null : String(row.user_id),
    reason: row.reason === null ? null : String(row.reason),
    score: row.score === null ? null : Number(row.score),
    receivedMs: Number(row.received_ms),
    resolvedMs: row.resolved_ms === null ? null : Number(row.resolved_ms),
    resolution: row.resolution === null ? null : String(row.resolution),
  };
}

const bad = (message: string) =>
  new MatrixError(400, 'M_INVALID_PARAM', message);
export async function listReports(db: Database, options: {
  from?: unknown;
  limit?: unknown;
  kind?: unknown;
  status?: unknown;
} = {}) {
  const from = options.from ?? 0, limit = options.limit ?? 100;
  if (!Number.isSafeInteger(from) || (from as number) < 0) {
    throw bad('invalid report cursor');
  }
  if (
    !Number.isSafeInteger(limit) || (limit as number) < 1 ||
    (limit as number) > 1000
  ) throw bad('report limit must be 1-1000');
  const clauses = ['id > ?'];
  const values: (string | number)[] = [from as number];
  if (options.kind !== undefined) {
    if (
      typeof options.kind !== 'string' ||
      !['event', 'room', 'user'].includes(options.kind)
    ) {
      throw bad('invalid report kind');
    }
    clauses.push('kind = ?');
    values.push(options.kind as string);
  }
  if (options.status !== undefined) {
    if (options.status === 'open') clauses.push('resolved_ms IS NULL');
    else if (options.status === 'resolved') {
      clauses.push('resolved_ms IS NOT NULL');
    } else throw bad('invalid report status');
  }
  const rows = await db.query(
    'SELECT * FROM reports WHERE ' + clauses.join(' AND ') +
      ' ORDER BY id LIMIT ?',
    [...values, (limit as number) + 1],
  );
  const page = rows.slice(0, limit as number).map(report);
  return {
    reports: page,
    ...(rows.length > (limit as number)
      ? { next: page[page.length - 1].id }
      : {}),
  };
}

export async function resolveReport(
  db: Database,
  id: unknown,
  resolution?: unknown,
) {
  if (!Number.isSafeInteger(id) || (id as number) < 1) {
    throw bad('invalid report id');
  }
  if (resolution !== undefined && typeof resolution !== 'string') {
    throw bad('resolution must be a string');
  }
  const resolved = Date.now();
  return await db.tx(async (tx) => {
    const rows = await tx.query('SELECT * FROM reports WHERE id = ?', [
      id as number,
    ]);
    if (rows.length === 0) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'report not found');
    }
    if (rows[0].resolved_ms === null) {
      await tx.execute(
        'UPDATE reports SET resolved_ms=?,resolution=? WHERE id=? AND resolved_ms IS NULL',
        [
          resolved,
          resolution === undefined ? null : resolution as string,
          id as number,
        ],
      );
      rows[0].resolved_ms = resolved;
      rows[0].resolution = resolution === undefined
        ? null
        : resolution as string;
    }
    return report(rows[0]);
  });
}
