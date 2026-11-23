// Opaque encrypted backup data is tenant-user truth, never room state.
import type { Conn } from '#engine/store/db.ts';
import type { Config } from '#engine/config-schema.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import { bounded, limitEntries, object } from '#engine/tenant/e2ee.ts';
import type { Json } from '#engine/tenant/e2ee.ts';
import {
  accountSession,
  EMPTY_BACKUP_BYTES,
  forgetBackupEntries,
} from '#engine/tenant/backup-accounting.ts';
import {
  importRegisterOperation,
  readRegister,
  registerJson,
  type RegisterOperation,
  registerOperations,
  writeRegister,
} from '#engine/facade/registers.ts';
import type { DomainHistoryProof } from '#engine/facade/domain-control.ts';
import { requireTenantDomainSource } from './domain-source.ts';
import { tenantAuthority } from './session-authority.ts';

type Limits = Config['e2ee'];
export type Action = 'get' | 'put' | 'delete' | 'post';
type VersionRow = {
  version_no: number;
  algorithm: string;
  auth_data: string;
  etag: number;
  deleted: number;
};
type Session = {
  first_message_index: number;
  forwarded_count: number;
  is_verified: boolean;
  session_data: Json;
};
type Entry = { room: string; session: string; data: Session };
export const BACKUP_PUBLICATION_SQL = `
ALTER TABLE backup_versions ADD COLUMN publication_id TEXT;
`;
const missing = () =>
  new MatrixError(404, 'M_NOT_FOUND', 'Unknown backup version or key');
function invalid(message: string): never {
  throw new MatrixError(400, 'M_INVALID_PARAM', message);
}
function versionNumber(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw missing();
  }
  return Number(value);
}
async function versionRow(
  conn: Conn,
  user: string,
  version?: string,
): Promise<VersionRow> {
  const rows = version === undefined
    ? await conn.query(
      'SELECT version_no,algorithm,auth_data,etag,deleted FROM backup_versions WHERE localpart=? AND deleted=0 ORDER BY version_no DESC LIMIT 1',
      [user],
    )
    : await conn.query(
      'SELECT version_no,algorithm,auth_data,etag,deleted FROM backup_versions WHERE localpart=? AND version_no=?',
      [user, versionNumber(version)],
    );
  if (!rows.length) {
    const pending = await conn.query(
      "SELECT 1 FROM domain_operations o WHERE kind='backup' AND json_extract(semantic_key,'$[1]')=?" +
        (version === undefined
          ? ''
          : " AND json_extract(semantic_key,'$[2]')=?") +
        " AND NOT EXISTS (SELECT 1 FROM backup_versions v WHERE v.localpart=json_extract(o.semantic_key,'$[1]') AND v.version_no=CAST(json_extract(o.semantic_key,'$[2]') AS INTEGER)) LIMIT 1",
      [user, ...(version === undefined ? [] : [version])],
    );
    if (pending.length) {
      throw new MatrixError(
        503,
        'M_UNAVAILABLE',
        'backup revision unavailable',
      );
    }
    throw missing();
  }
  const row = rows[0];
  return {
    version_no: Number(row.version_no),
    algorithm: String(row.algorithm),
    auth_data: String(row.auth_data),
    etag: Number(row.etag),
    deleted: Number(row.deleted),
  };
}
async function stats(conn: Conn, user: string, row: VersionRow) {
  const result = await conn.query(
    'SELECT session_count AS n FROM backup_versions WHERE localpart=? AND version_no=?',
    [user, row.version_no],
  );
  return { count: Number(result[0].n), etag: String(row.etag) };
}

function backupOverflow(): never {
  throw new MatrixError(
    413,
    'M_TOO_LARGE',
    'Backup restore byte limit exceeded',
  );
}

// Counters and ciphertext share the writing transaction. Capacity is independent
// of individual request size and reads no retained session identifiers/payloads.
async function assertRestoreCapacity(
  conn: Conn,
  user: string,
  version: number,
  limits: Limits,
): Promise<void> {
  const rows = await conn.query(
    'SELECT restore_bytes FROM backup_versions WHERE localpart=? AND version_no=?',
    [user, version],
  );
  if (Number(rows[0].restore_bytes) > limits.maxbackupbytes) backupOverflow();
}

export async function backupVersion(
  conn: Conn,
  user: string,
  action: Action,
  version: string | undefined,
  input: unknown,
  limits: Limits,
): Promise<Json> {
  if (action !== 'get') await requireBackupWriter(conn, user);
  if (action === 'post') {
    const body = metadata(input, limits);
    const active = await conn.query(
      'SELECT COUNT(*) AS n FROM backup_versions WHERE localpart=? AND deleted=0',
      [user],
    );
    limitEntries(Number(active[0].n) + 1, limits.maxbackupversions);
    const next = await nextCounter(conn, 'backup:' + user);
    if (!Number.isSafeInteger(next)) {
      throw new MatrixError(
        413,
        'M_TOO_LARGE',
        'Backup version space exhausted',
      );
    }
    await conn.execute(
      'INSERT INTO backup_versions(localpart,version_no,algorithm,auth_data,etag,deleted) VALUES(?,?,?,?,0,0)',
      [user, next, body.algorithm, JSON.stringify(body.auth_data)],
    );
    await recordBackupVersion(conn, user, next);
    return { version: String(next) };
  }
  const row = await versionRow(conn, user, version);
  if (action === 'delete') {
    await forgetBackupEntries(conn, user, row.version_no);
    await conn.execute(
      "UPDATE backup_versions SET deleted=1,auth_data='{}' WHERE localpart=? AND version_no=?",
      [user, row.version_no],
    );
    if (!row.deleted) await recordBackupVersion(conn, user, row.version_no);
    return {};
  }
  if (row.deleted) throw missing();
  if (action === 'put') {
    const body = metadata(input, limits);
    if (
      body.algorithm !== row.algorithm ||
      (body.version !== undefined && body.version !== version)
    ) invalid('Backup algorithm or version does not match');
    await conn.execute(
      'UPDATE backup_versions SET auth_data=? WHERE localpart=? AND version_no=?',
      [JSON.stringify(body.auth_data), user, row.version_no],
    );
    if (
      registerJson(row.auth_data) !==
        registerJson(JSON.stringify(body.auth_data))
    ) {
      await recordBackupVersion(conn, user, row.version_no);
    }
    return {};
  }
  const result = {
    version: String(row.version_no),
    algorithm: row.algorithm,
    auth_data: JSON.parse(row.auth_data),
    ...await stats(conn, user, row),
  };
  bounded(result, limits.maxbackupbytes);
  return result;
}
function metadata(
  input: unknown,
  limits: Limits,
): Json & { algorithm: string; auth_data: Json } {
  bounded(input, limits.maxrequestbytes);
  const body = object(input, 'backup metadata');
  if (typeof body.algorithm !== 'string' || !body.algorithm.length) {
    invalid('Backup algorithm required');
  }
  const auth = object(body.auth_data, 'auth_data');
  bounded(body, limits.maxkeybytes);
  bounded({
    version: String(Number.MAX_SAFE_INTEGER),
    algorithm: body.algorithm,
    auth_data: auth,
    count: Number.MAX_SAFE_INTEGER,
    etag: String(Number.MAX_SAFE_INTEGER),
  }, limits.maxbackupbytes);
  return { ...body, algorithm: body.algorithm, auth_data: auth };
}
function sessionData(input: unknown, limits: Limits): Session {
  const body = object(input, 'session');
  for (const field of ['first_message_index', 'forwarded_count']) {
    if (!Number.isSafeInteger(body[field]) || Number(body[field]) < 0) {
      invalid(field + ' must be a nonnegative integer');
    }
  }
  if (typeof body.is_verified !== 'boolean') {
    invalid('is_verified must be a boolean');
  }
  const result = {
    first_message_index: Number(body.first_message_index),
    forwarded_count: Number(body.forwarded_count),
    is_verified: body.is_verified,
    session_data: object(body.session_data, 'session_data'),
  };
  bounded(result, limits.maxkeybytes);
  return result;
}
function entries(
  input: unknown,
  room: string | undefined,
  session: string | undefined,
  limits: Limits,
): Entry[] {
  bounded(input, limits.maxrequestbytes);
  const result: Entry[] = [];
  const add = (r: string, s: string, value: unknown) => {
    if (!r.length || !s.length) {
      invalid('Room and session IDs must not be empty');
    }
    bounded([r, s], limits.maxkeybytes);
    limitEntries(result.length + 1, limits.maxkeys);
    result.push({ room: r, session: s, data: sessionData(value, limits) });
  };
  if (room !== undefined && session !== undefined) add(room, session, input);
  else {
    const rooms = room === undefined
      ? object(object(input, 'body').rooms, 'rooms')
      : { [room]: input };
    for (const [r, value] of Object.entries(rooms)) {
      for (
        const [s, data] of Object.entries(
          object(object(value, 'room').sessions, 'sessions'),
        )
      ) add(r, s, data);
    }
  }
  return result;
}
function better(next: Session, old: Session): boolean {
  if (next.is_verified !== old.is_verified) return next.is_verified;
  if (next.first_message_index !== old.first_message_index) {
    return next.first_message_index < old.first_message_index;
  }
  return next.forwarded_count < old.forwarded_count;
}
export async function backupKeys(
  conn: Conn,
  user: string,
  action: Action,
  version: string | null,
  room: string | undefined,
  session: string | undefined,
  input: unknown,
  limits: Limits,
): Promise<Json> {
  if (action !== 'get') await requireBackupWriter(conn, user);
  if (version === null) {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'version is required');
  }
  const updates = action === 'put' ? entries(input, room, session, limits) : [];
  const row = await versionRow(conn, user, version);
  if (row.deleted) throw missing();
  const args = [
    user,
    row.version_no,
    ...(room === undefined ? [] : [room]),
    ...(session === undefined ? [] : [session]),
  ];
  const where = 'localpart=? AND version_no=?' +
    (room === undefined ? '' : ' AND room_id=?') +
    (session === undefined ? '' : ' AND session_id=?');
  let changed = false;
  const sessions: string[] = [];
  if (action === 'put') {
    const current = await versionRow(conn, user);
    if (current.version_no !== row.version_no) {
      throw new MatrixError(
        403,
        'M_WRONG_ROOM_KEYS_VERSION',
        'Wrong backup version',
        {
          errcode: 'M_WRONG_ROOM_KEYS_VERSION',
          error: 'Wrong backup version',
          current_version: String(current.version_no),
        },
      );
    }
    for (const entry of updates) {
      const previous = await conn.query(
        'SELECT payload FROM backup_sessions WHERE localpart=? AND version_no=? AND room_id=? AND session_id=?',
        [user, row.version_no, entry.room, entry.session],
      );
      if (
        !previous.length ||
        better(entry.data, JSON.parse(String(previous[0].payload)))
      ) {
        const payload = JSON.stringify(entry.data);
        await conn.execute(
          'INSERT INTO backup_sessions(localpart,version_no,room_id,session_id,payload) VALUES(?,?,?,?,?) ON CONFLICT(localpart,version_no,room_id,session_id) DO UPDATE SET payload=excluded.payload',
          [
            user,
            row.version_no,
            entry.room,
            entry.session,
            payload,
          ],
        );
        await accountSession(
          conn,
          user,
          row.version_no,
          entry.room,
          entry.session,
          payload,
          previous.length ? String(previous[0].payload) : undefined,
        );
        const fact = await recordBackupSession(
          conn,
          user,
          row.version_no,
          entry.room,
          entry.session,
          entry.data,
        );
        if (fact) sessions.push(fact.operation.operationId);
        changed = true;
      }
    }
    const total = await conn.query(
      'SELECT COALESCE(SUM(session_count),0) AS n FROM backup_versions WHERE localpart=?',
      [user],
    );
    limitEntries(Number(total[0].n), limits.maxbackupsessions);
    await assertRestoreCapacity(conn, user, row.version_no, limits);
  } else if (action === 'delete') {
    const removed = await tenantAuthority(conn)
      ? await conn.query(
        'SELECT room_id,session_id FROM backup_sessions WHERE ' + where,
        args,
      )
      : [];
    changed = await forgetBackupEntries(
      conn,
      user,
      row.version_no,
      room,
      session,
    );
    for (const entry of removed) {
      const fact = await recordBackupSession(
        conn,
        user,
        row.version_no,
        String(entry.room_id),
        String(entry.session_id),
        null,
      );
      if (fact) sessions.push(fact.operation.operationId);
    }
  } else {
    const rows = await conn.query(
      'SELECT room_id,session_id,payload FROM backup_sessions WHERE ' + where +
        ' ORDER BY room_id,session_id LIMIT ?',
      [...args, limits.maxbackupsessions + 1],
    );
    limitEntries(rows.length, limits.maxbackupsessions);
    if (session !== undefined) {
      if (!rows.length) throw missing();
      const result = JSON.parse(String(rows[0].payload));
      bounded(result, limits.maxbackupbytes);
      return result;
    }
    const rooms: Record<string, { sessions: Json }> = Object.create(null);
    for (const stored of rows) {
      const r = String(stored.room_id);
      const value = rooms[r] ??= { sessions: Object.create(null) };
      value.sessions[String(stored.session_id)] = JSON.parse(
        String(stored.payload),
      );
    }
    const result = room === undefined
      ? { rooms }
      : rooms[room] ?? { sessions: {} };
    bounded(result, limits.maxbackupbytes);
    return result;
  }
  if (changed) {
    row.etag++;
    if (!Number.isSafeInteger(row.etag)) {
      throw new MatrixError(
        413,
        'M_TOO_LARGE',
        'Backup revision space exhausted',
      );
    }
    await conn.execute(
      'UPDATE backup_versions SET etag=? WHERE localpart=? AND version_no=?',
      [row.etag, user, row.version_no],
    );
    await recordBackupVersion(conn, user, row.version_no, sessions);
  }
  return await stats(conn, user, row);
}

export async function clearBackup(conn: Conn, user: string): Promise<void> {
  await conn.execute('DELETE FROM backup_sessions WHERE localpart=?', [user]);
  await conn.execute('DELETE FROM backup_rooms WHERE localpart=?', [user]);
  await conn.execute(
    "UPDATE backup_versions SET deleted=1,auth_data='{}',session_count=0,restore_bytes=? WHERE localpart=?",
    [EMPTY_BACKUP_BYTES, user],
  );
}

function semanticKey(user: string, version: string) {
  return JSON.stringify(['backup', user, version]);
}

async function requireBackupWriter(conn: Conn, user: string) {
  const authority = await tenantAuthority(conn);
  if (authority && authority.node !== 'home') {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      'operation requires home ingress',
    );
  }
  // Standalone conn-level accounting callers need not create a user row. A held
  // terminal account, however, must never recreate its cleared private data.
  const [account] = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [user],
  );
  if (account?.deactivated === 1) {
    throw new MatrixError(403, 'M_USER_DEACTIVATED', 'account is deactivated');
  }
}

type BackupRevision = {
  version: string;
  algorithm: string;
  auth_data: Json;
  etag: string;
  deleted: boolean;
  count: number;
  sessions: string[];
};

async function heldRevision(
  conn: Conn,
  user: string,
  version: number,
): Promise<BackupRevision> {
  const row = await versionRow(conn, user, String(version));
  return {
    version: String(version),
    algorithm: row.algorithm,
    auth_data: JSON.parse(row.auth_data),
    etag: String(row.etag),
    deleted: row.deleted === 1,
    count: (await stats(conn, user, row)).count,
    sessions: [],
  };
}

function sessionKey(
  user: string,
  version: number,
  room: string,
  session: string,
) {
  return JSON.stringify(['backup', user, String(version), room, session]);
}

async function recordBackupSession(
  conn: Conn,
  user: string,
  version: number,
  room: string,
  session: string,
  data: Session | null,
) {
  const authority = await tenantAuthority(conn);
  if (!authority) return;
  if (authority.node !== 'home') throw new Error('backup source is not home');
  return await writeRegister(
    conn,
    { source: authority.node, incarnation: authority.incarnation },
    sessionKey(user, version, room, session),
    'backup',
    JSON.stringify({ data }),
  );
}

async function recordBackupVersion(
  conn: Conn,
  user: string,
  version: number,
  sessions: string[] = [],
) {
  const authority = await tenantAuthority(conn);
  if (!authority) return;
  if (authority.node !== 'home') throw new Error('backup source is not home');
  await writeRegister(
    conn,
    { source: authority.node, incarnation: authority.incarnation },
    semanticKey(user, String(version)),
    'backup',
    JSON.stringify({ ...await heldRevision(conn, user, version), sessions }),
  );
}

export async function backupOperations(conn: Conn, user: string) {
  const keys = await conn.query(
    "SELECT DISTINCT semantic_key FROM domain_operations WHERE kind='backup' AND json_extract(semantic_key,'$[1]')=? ORDER BY semantic_key",
    [user],
  );
  const operations: RegisterOperation[] = [];
  for (const key of keys) {
    operations.push(
      ...await registerOperations(conn, String(key.semantic_key)),
    );
  }
  return operations;
}

export async function captureBackupOperations(conn: Conn, user: string) {
  if ((await tenantAuthority(conn))?.node !== 'home') {
    throw new Error('backup bootstrap requires home authority');
  }
  const [account] = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [user],
  );
  if (!account || account.deactivated === 1) return [];
  for (
    const row of await conn.query(
      'SELECT version_no FROM backup_versions WHERE localpart=? ORDER BY version_no',
      [user],
    )
  ) {
    const version = Number(row.version_no);
    if (
      (await registerOperations(conn, semanticKey(user, String(version))))
        .length
    ) continue;
    const sessions: string[] = [];
    for (
      const entry of await conn.query(
        'SELECT room_id,session_id,payload FROM backup_sessions WHERE localpart=? AND version_no=? ORDER BY room_id,session_id',
        [user, version],
      )
    ) {
      const room = String(entry.room_id), session = String(entry.session_id);
      let held = await readRegister(
        conn,
        sessionKey(user, version, room, session),
      );
      if (!held.winner) {
        await recordBackupSession(
          conn,
          user,
          version,
          room,
          session,
          JSON.parse(String(entry.payload)),
        );
        held = await readRegister(
          conn,
          sessionKey(user, version, room, session),
        );
      }
      sessions.push(held.winner!.operationId);
    }
    await recordBackupVersion(conn, user, version, sessions);
  }
  return await backupOperations(conn, user);
}

function revisionOf(
  operation: RegisterOperation,
  limits: Limits,
): {
  user: string;
  version: number;
  room?: string;
  session?: string;
  data?: Session | null;
  revision?: BackupRevision;
} {
  let key: unknown, raw: unknown;
  try {
    key = JSON.parse(operation.semanticKey);
    raw = JSON.parse(operation.payload);
  } catch {
    // Parser diagnostics may quote protected metadata or ciphertext.
    throw new Error('invalid backup revision');
  }
  const body = object(raw, 'backup revision');
  if (
    !Array.isArray(key) || ![3, 5].includes(key.length) ||
    key[0] !== 'backup' ||
    typeof key[1] !== 'string' || !key[1] || typeof key[2] !== 'string' ||
    operation.semanticKey !== JSON.stringify(key) ||
    operation.kind !== 'backup' || operation.source !== 'home'
  ) {
    throw new Error('invalid backup revision');
  }
  const version = versionNumber(key[2]);
  if (key.length === 5) {
    if (
      typeof key[3] !== 'string' || !key[3] || typeof key[4] !== 'string' ||
      !key[4] ||
      Object.keys(body).join(',') !== 'data' ||
      (body.data !== null &&
        registerJson(JSON.stringify(sessionData(body.data, limits))) !==
          registerJson(JSON.stringify(body.data)))
    ) {
      throw new Error('invalid backup session');
    }
    return {
      user: key[1],
      version,
      room: key[3],
      session: key[4],
      data: body.data as Session | null,
    };
  }
  if (
    body.version !== key[2] ||
    Object.keys(body).sort().join(',') !==
      'algorithm,auth_data,count,deleted,etag,sessions,version' ||
    typeof body.algorithm !== 'string' || !body.algorithm ||
    typeof body.etag !== 'string' || !/^(0|[1-9][0-9]*)$/.test(body.etag) ||
    !Number.isSafeInteger(Number(body.etag)) ||
    typeof body.deleted !== 'boolean' || !Number.isSafeInteger(body.count) ||
    Number(body.count) < 0 || !Array.isArray(body.sessions) ||
    body.sessions.some((id) => typeof id !== 'string' || !id) ||
    new Set(body.sessions).size !== body.sessions.length
  ) {
    throw new Error('invalid backup metadata');
  }
  object(body.auth_data, 'auth_data');
  if (
    body.deleted &&
    (body.count !== 0 || Object.keys(body.auth_data as Json).length)
  ) throw new Error('deleted backup has private data');
  return { user: key[1], version, revision: body as unknown as BackupRevision };
}

/** Retention is independent of publication. A metadata revision names its exact
 * session delta; neither side becomes visible until the entire revision is held. */
export async function importBackup(
  conn: Conn,
  operation: RegisterOperation,
  limits: Limits,
  history?: DomainHistoryProof,
) {
  const { user, version } = revisionOf(operation, limits);
  await requireTenantDomainSource(conn, operation, user, history);
  await importRegisterOperation(conn, operation);
  const [account] = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [user],
  );
  if (!account) throw new Error('backup account unavailable');
  if (account.deactivated === 1) return;
  await publishBackupRevisions(conn, user, version, limits);
}

async function publishBackupRevisions(
  conn: Conn,
  user: string,
  version: number,
  limits: Limits,
) {
  const key = semanticKey(user, String(version));
  const held = await readRegister(conn, key);
  if (!held.winner) return;
  const [previous] = await conn.query(
    'SELECT publication_id FROM backup_versions WHERE localpart=? AND version_no=?',
    [user, version],
  );
  const published = previous?.publication_id;
  const operations = new Map(
    [...held.conflicts, held.winner].map((op) => [op.operationId, op]),
  );
  const revisions: RegisterOperation[] = [];
  const seen = new Set<string>();
  function visit(op: RegisterOperation) {
    if (op.operationId === published || seen.has(op.operationId)) return;
    seen.add(op.operationId);
    for (const dot of op.context) {
      const id = JSON.stringify([
        dot.source,
        dot.incarnation,
        op.stream,
        dot.sequence,
      ]);
      const parent = operations.get(id);
      if (!parent) throw new Error('backup revision predecessor unavailable');
      visit(parent);
    }
    revisions.push(op);
  }
  visit(held.winner);
  for (const op of revisions) {
    const revision = revisionOf(op, limits).revision!;
    const delta: ReturnType<typeof revisionOf>[] = [];
    for (const id of revision.sessions) {
      const [row] = await conn.query(
        'SELECT semantic_key FROM domain_operations WHERE operation_id=?',
        [id],
      );
      if (!row) return;
      const view = await readRegister(conn, String(row.semantic_key));
      const session = [view.winner, ...view.conflicts].find((fact) =>
        fact?.operationId === id
      );
      if (!session) return;
      const fact = revisionOf(session, limits);
      if (
        fact.user !== user || fact.version !== version ||
        fact.data === undefined
      ) {
        throw new Error('backup revision session mismatch');
      }
      delta.push(fact);
    }
    // Reconstruct an unqualified legacy replica only from the complete root,
    // never from independently materialized session winners.
    if (previous && !published && op === revisions[0]) {
      await forgetBackupEntries(conn, user, version);
    }
    await conn.execute(
      'INSERT INTO backup_versions(localpart,version_no,algorithm,auth_data,etag,deleted,session_count,restore_bytes) VALUES(?,?,?,?,?,?,0,?) ON CONFLICT(localpart,version_no) DO UPDATE SET algorithm=excluded.algorithm,auth_data=excluded.auth_data,etag=excluded.etag,deleted=excluded.deleted',
      [
        user,
        version,
        revision.algorithm,
        JSON.stringify(revision.auth_data),
        Number(revision.etag),
        revision.deleted ? 1 : 0,
        EMPTY_BACKUP_BYTES,
      ],
    );
    if (revision.deleted) await forgetBackupEntries(conn, user, version);
    else for (const fact of delta) await projectBackupSession(conn, user, fact);
    const [total] = await conn.query(
      'SELECT session_count FROM backup_versions WHERE localpart=? AND version_no=?',
      [user, version],
    );
    if (Number(total.session_count) !== revision.count) {
      throw new Error('backup revision accounting mismatch');
    }
    await conn.execute(
      'UPDATE backup_versions SET publication_id=? WHERE localpart=? AND version_no=?',
      [op.operationId, user, version],
    );
  }
}

async function projectBackupSession(
  conn: Conn,
  user: string,
  fact: ReturnType<typeof revisionOf>,
) {
  const { version, room, session, data } = fact;
  if (room === undefined || session === undefined || data === undefined) {
    throw new Error('invalid backup session');
  }
  const [metadata] = await conn.query(
    'SELECT deleted FROM backup_versions WHERE localpart=? AND version_no=?',
    [user, version],
  );
  if (!metadata || metadata.deleted === 1) return;
  if (data === null) {
    await forgetBackupEntries(conn, user, version, room, session);
    return;
  }
  const [previous] = await conn.query(
    'SELECT payload FROM backup_sessions WHERE localpart=? AND version_no=? AND room_id=? AND session_id=?',
    [user, version, room, session],
  );
  const payload = JSON.stringify(data);
  if (
    previous && registerJson(String(previous.payload)) === registerJson(payload)
  ) return;
  await conn.execute(
    'INSERT INTO backup_sessions(localpart,version_no,room_id,session_id,payload) VALUES(?,?,?,?,?) ON CONFLICT(localpart,version_no,room_id,session_id) DO UPDATE SET payload=excluded.payload',
    [user, version, room, session, payload],
  );
  await accountSession(
    conn,
    user,
    version,
    room,
    session,
    payload,
    previous ? String(previous.payload) : undefined,
  );
}
