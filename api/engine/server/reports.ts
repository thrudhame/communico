// Reports are durable server-owned intent, not a projection of room events.
// Never persist event content or copy report reasons into logs or federation.
import type { Database } from '#engine/store/db.ts';
import type { Row } from '#engine/store/ffi.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { config } from '#engine/config.ts';
import type { Conn } from '#engine/store/db.ts';
import { Buffer } from 'node:buffer';
import { domainOf } from '#engine/ids.ts';
import {
  type DomainHistoryProof,
  requireDomainSources,
} from '#engine/facade/domain-control.ts';
import {
  importRegisterOperation,
  registerJson,
  type RegisterOperation,
  registerOperations,
  writeRegister,
} from '#engine/facade/registers.ts';

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

type ReportValue = {
  reportId: string;
  kind: ReportKind;
  reporter: string;
  roomId: string | null;
  eventId: string | null;
  userId: string | null;
  reason: string | null;
  score: number | null;
  receivedMs: number;
};
type ResolutionValue = {
  reportId: string;
  resolvedMs: number;
  resolution: string | null;
};

async function authority(conn: Conn) {
  const [row] = await conn.query(
    'SELECT c.signed_json,p.node FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision CROSS JOIN publication_domain p WHERE p.singleton=1',
  );
  if (!row) return null;
  const body = JSON.parse(String(row.signed_json)).body;
  const node = (body.nodes as { node: string; incarnation: string }[]).find((
    node,
  ) => node.node === row.node);
  if (!node) throw new Error('report source unavailable');
  return {
    server: String(body.server),
    source: node.node,
    incarnation: node.incarnation,
    nodes: body.nodes as { node: string; incarnation: string }[],
  };
}
function reportKey(kind: string, localpart: string, id: string) {
  return JSON.stringify([kind, localpart, id]);
}
function reportId(
  source: { source: string; incarnation: string },
  suffix: string,
) {
  return 'r.' +
    Buffer.from(JSON.stringify([source.source, source.incarnation])).toString(
      'base64url',
    ) + '.' + suffix;
}
function issuer(id: string): [string, string] | null {
  const match = /^r\.([A-Za-z0-9_-]+)\.([a-f0-9-]{36}|legacy-[1-9][0-9]*)$/
    .exec(id);
  if (!match) return null;
  try {
    const source = JSON.parse(
      Buffer.from(match[1], 'base64url').toString('utf8'),
    );
    if (
      Array.isArray(source) && source.length === 2 && source.every((s) =>
        typeof s === 'string' && /^[\x21-\x7e]+$/.test(s)
      ) &&
      reportId({ source: source[0], incarnation: source[1] }, match[2]) ===
        id &&
      (!match[2].startsWith('legacy-') || source[0] === 'home')
    ) return source as [string, string];
  } catch { /* Invalid protected input never enters diagnostics. */ }
  return null;
}
function localpart(reporter: string, server: string) {
  if (!/^@[^:]+:.+$/.test(reporter) || domainOf(reporter) !== server) {
    throw new Error('report account unavailable');
  }
  return reporter.slice(1, reporter.indexOf(':'));
}
async function insert(
  conn: Conn,
  value: ReportValue | (Omit<ReportValue, 'reportId'> & { reportId: null }),
) {
  await conn.execute(
    'INSERT INTO reports(report_id,kind,reporter,room_id,event_id,user_id,reason,score,received_ms) VALUES(?,?,?,?,?,?,?,?,?)',
    [
      value.reportId,
      value.kind,
      value.reporter,
      value.roomId,
      value.eventId,
      value.userId,
      value.reason,
      value.score,
      value.receivedMs,
    ],
  );
}

export async function storeReport(db: Database, input: ReportInput) {
  // Identity and time are fixed before entering the retryable transaction.
  const uuid = crypto.randomUUID(), receivedMs = Date.now();
  await db.tx(async (conn) => {
    const source = await authority(conn);
    if (
      !source &&
      (await conn.query(
        "SELECT 1 FROM runtime_identity WHERE singleton=1 AND role='facade'",
      )).length
    ) throw new MatrixError(503, 'M_UNAVAILABLE', 'report source unavailable');
    const value = {
      kind: input.kind,
      reporter: input.reporter,
      roomId: input.roomId ?? null,
      eventId: input.eventId ?? null,
      userId: input.userId ?? null,
      reason: input.reason ?? null,
      score: input.score ?? null,
      receivedMs,
      reportId: source ? reportId(source, uuid) : null,
    };
    if (source) {
      await writeRegister(
        conn,
        source,
        reportKey(
          'report',
          localpart(input.reporter, source.server),
          value.reportId!,
        ),
        'report',
        JSON.stringify(value),
      );
    }
    await insert(conn, value);
  });
}

export async function reportOperations(conn: Conn, reporter: string) {
  const source = await authority(conn);
  if (!source) return [];
  const name = localpart(reporter, source.server);
  const keys = await conn.query(
    "SELECT DISTINCT semantic_key FROM domain_operations WHERE kind IN ('report','report-resolution') AND json_extract(semantic_key,'$[1]')=? ORDER BY semantic_key",
    [name],
  );
  const operations: RegisterOperation[] = [];
  for (const key of keys) {
    operations.push(
      ...await registerOperations(conn, String(key.semantic_key)),
    );
  }
  return operations;
}

async function capture(
  conn: Conn,
  row: Row,
  source: NonNullable<Awaited<ReturnType<typeof authority>>>,
) {
  if (source.source !== 'home') {
    throw new Error('report baseline requires home authority');
  }
  if (row.report_id === null) {
    const id = reportId(source, 'legacy-' + row.id);
    await conn.execute('UPDATE reports SET report_id=? WHERE id=?', [
      id,
      Number(row.id),
    ]);
    row.report_id = id;
    const value = report(row);
    const {
      id: _id,
      resolvedMs: _resolved,
      resolution: _resolution,
      ...submission
    } = value;
    await writeRegister(
      conn,
      source,
      reportKey('report', localpart(value.reporter, source.server), id),
      'report',
      JSON.stringify(submission),
    );
  } else if (
    !(await registerOperations(
      conn,
      reportKey(
        'report',
        localpart(String(row.reporter), source.server),
        String(row.report_id),
      ),
    )).length
  ) {
    throw new Error('report source fact unavailable');
  }
  if (row.resolved_ms !== null) {
    const key = reportKey(
      'report-resolution',
      localpart(String(row.reporter), source.server),
      String(row.report_id),
    );
    if (!(await registerOperations(conn, key)).length) {
      await writeRegister(
        conn,
        source,
        key,
        'report-resolution',
        JSON.stringify({
          reportId: String(row.report_id),
          resolvedMs: Number(row.resolved_ms),
          resolution: row.resolution,
        }),
      );
    }
  }
}

export async function captureReportOperations(conn: Conn, reporter: string) {
  const source = await authority(conn);
  if (!source || source.source !== 'home') {
    throw new Error('report bootstrap requires home authority');
  }
  for (
    const row of await conn.query(
      'SELECT * FROM reports WHERE reporter=? ORDER BY id',
      [reporter],
    )
  ) await capture(conn, row, source);
  return await reportOperations(conn, reporter);
}

function decode(operation: RegisterOperation, server: string) {
  let key: unknown, raw: unknown;
  try {
    key = JSON.parse(operation.semanticKey);
    raw = JSON.parse(operation.payload);
  } catch {
    throw new Error('invalid report fact');
  }
  if (
    !Array.isArray(key) || key.length !== 3 ||
    !['report', 'report-resolution'].includes(key[0]) ||
    operation.kind !== key[0] || typeof key[1] !== 'string' || !key[1] ||
    typeof key[2] !== 'string' ||
    operation.semanticKey !== reportKey(key[0], key[1], key[2]) ||
    operation.sequence !== 1 || !Array.isArray(operation.context) ||
    operation.context.length || !raw || typeof raw !== 'object' ||
    Array.isArray(raw)
  ) throw new Error('invalid report fact');
  const value = raw as ReportValue & ResolutionValue;
  const owner = issuer(key[2]);
  if (!owner || value.reportId !== key[2]) {
    throw new Error('invalid report identity');
  }
  const nullable = (v: unknown) => v === null || typeof v === 'string';
  let normalized: ReportValue | ResolutionValue;
  if (operation.kind === 'report') {
    if (
      owner[0] !== operation.source || owner[1] !== operation.incarnation ||
      !['event', 'room', 'user'].includes(value.kind) ||
      value.reporter !== '@' + key[1] + ':' + server ||
      ![value.roomId, value.eventId, value.userId, value.reason].every(
        nullable,
      ) || !(value.score === null || Number.isSafeInteger(value.score)) ||
      !Number.isSafeInteger(value.receivedMs) || value.receivedMs < 0 ||
      (value.kind === 'event'
        ? !value.roomId?.startsWith('!') || !value.eventId?.startsWith('$') ||
          value.userId !== null
        : value.kind === 'room'
        ? !value.roomId?.startsWith('!') || value.eventId !== null ||
          value.userId !== null || value.score !== null
        : !value.userId?.startsWith('@') || domainOf(value.userId) !== server ||
          value.roomId !== null || value.eventId !== null ||
          value.score !== null) ||
      (value.kind !== 'event' && typeof value.reason !== 'string')
    ) throw new Error('invalid report submission');
    normalized = {
      reportId: value.reportId,
      kind: value.kind,
      reporter: value.reporter,
      roomId: value.roomId,
      eventId: value.eventId,
      userId: value.userId,
      reason: value.reason,
      score: value.score,
      receivedMs: value.receivedMs,
    };
  } else {
    if (
      operation.source !== 'home' || !Number.isSafeInteger(value.resolvedMs) ||
      value.resolvedMs < 0 || !nullable(value.resolution)
    ) throw new Error('invalid report resolution');
    normalized = {
      reportId: value.reportId,
      resolvedMs: value.resolvedMs,
      resolution: value.resolution,
    };
  }
  if (registerJson(JSON.stringify(normalized)) !== operation.payload) {
    throw new Error('invalid report fact');
  }
  return { localpart: key[1] as string, value: normalized };
}

/** Append-union, not register winner selection. Submissions and the one home
 * resolution are immutable independent facts; either may arrive first. */
export async function importReportOperation(
  db: Database,
  operation: RegisterOperation,
  check: (conn: Conn) => Promise<void>,
  history?: DomainHistoryProof,
) {
  await db.tx(async (conn) => {
    await check(conn);
    const source = await authority(conn);
    if (!source) throw new Error('report source unavailable');
    const decoded = decode(operation, source.server);
    await requireDomainSources(
      conn,
      operation,
      source.nodes.map((n) => ({ source: n.node, incarnation: n.incarnation })),
      decoded.localpart,
      history,
    );
    const prior = await registerOperations(conn, operation.semanticKey);
    if (
      prior.some((fact) =>
        registerJson(JSON.stringify(fact)) !==
          registerJson(JSON.stringify(operation))
      )
    ) throw new Error('immutable report fact differs');
    await importRegisterOperation(conn, operation);
    const id = decoded.value.reportId;
    const submissions = await registerOperations(
      conn,
      reportKey('report', decoded.localpart, id),
    );
    if (!submissions.length) return;
    const submission = decode(submissions[0], source.server)
      .value as ReportValue;
    const [held] = await conn.query('SELECT * FROM reports WHERE report_id=?', [
      id,
    ]);
    if (!held) await insert(conn, submission);
    else {
      const {
        id: _id,
        resolvedMs: _resolved,
        resolution: _resolution,
        ...value
      } = report(held);
      if (registerJson(JSON.stringify(value)) !== submissions[0].payload) {
        throw new Error('report materialization differs');
      }
    }
    const resolutions = await registerOperations(
      conn,
      reportKey('report-resolution', decoded.localpart, id),
    );
    if (resolutions.length) {
      const resolution = decode(resolutions[0], source.server)
        .value as ResolutionValue;
      await conn.execute(
        'UPDATE reports SET resolved_ms=?,resolution=? WHERE report_id=?',
        [resolution.resolvedMs, resolution.resolution, id],
      );
    }
  });
}

function report(row: Row) {
  return {
    id: Number(row.id),
    reportId: row.report_id === null ? null : String(row.report_id),
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
  // Plan the page without transporting reasons/resolutions across FFI. Every
  // UTF-8 byte costs at most six JSON bytes (control characters -> \u00xx);
  // fixed slack covers keys, numbers, nulls and the admin response envelope.
  // The request byte setting is a page target, NOT a report field cap: an
  // oversized first row travels intact, alone, so pagination always advances.
  const textBytes = [
    'kind',
    'report_id',
    'reporter',
    'room_id',
    'event_id',
    'user_id',
    'reason',
    'resolution',
  ]
    .map((column) => `coalesce(length(cast(${column} AS BLOB)),0)`)
    .join('+');
  const budget = config().server.maxrequestbytes;
  return await db.tx(async (tx) => {
    const sizes = await tx.query(
      'SELECT id, 1024 + 6 * (' + textBytes + ') AS bytes FROM reports WHERE ' +
        clauses.join(' AND ') +
        ' ORDER BY id LIMIT ?',
      [...values, (limit as number) + 1],
    );
    const ids: number[] = [];
    let bytes = 128;
    for (const row of sizes) {
      if (ids.length >= (limit as number)) break;
      if (ids.length > 0 && bytes + Number(row.bytes) > budget) break;
      ids.push(Number(row.id));
      bytes += Number(row.bytes);
    }
    // Same snapshot as the size plan: concurrent resolution cannot enlarge the
    // selected rows between measuring and hydration. Never hydrate lookahead.
    const page = ids.length === 0 ? [] : (await tx.query(
      `SELECT * FROM reports WHERE id IN (${
        ids.map(() => '?').join(',')
      }) ORDER BY id`,
      ids,
    )).map(report);
    return {
      reports: page,
      ...(sizes.length > ids.length ? { next: ids[ids.length - 1] } : {}),
    };
  }, { mode: 'deferred' });
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
    const source = await authority(tx);
    if (
      (source && source.source !== 'home') ||
      (await tx.query(
        "SELECT 1 FROM runtime_identity WHERE singleton=1 AND role='facade'",
      )).length
    ) {
      throw new MatrixError(
        503,
        'M_UNAVAILABLE',
        'operation requires home ingress',
      );
    }
    const rows = await tx.query('SELECT * FROM reports WHERE id = ?', [
      id as number,
    ]);
    if (rows.length === 0) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'report not found');
    }
    if (rows[0].resolved_ms === null) {
      if (source) await capture(tx, rows[0], source);
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
      if (source) await capture(tx, rows[0], source);
    }
    return report(rows[0]);
  });
}
