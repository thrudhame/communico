// api/engine/tenant/accountdata.ts — account data (M2): global rows
// (room_id '') and per-room rows, each write stamped with the next stream
// position (D10: the sync token's _a<n> moves, incremental syncs deliver
// rows with seq > the token, long-polls wake). The old account_data_seq
// sequence is the 'account_data' row of `counters`, advanced inside the
// same tenant transaction as the write it stamps; the push-rule stream
// marker rides the same counter.
import type { Conn } from '#engine/store/db.ts';
import type { Tenant, TenantTx } from '#engine/tenant/index.ts';
import { rulesetAt } from '#engine/tenant/pushrules.ts';
import {
  captureRegisterBaseline,
  importRegisterOperation,
  readRegister,
  registerJson,
  type RegisterOperation,
  registerOperations,
  registerWinner,
  writeRegister,
} from '#engine/facade/registers.ts';
import { tenantAuthority } from '#engine/tenant/session-authority.ts';
import { MatrixError } from '#engine/matrix-error.ts';
export async function clearAccountData(
  conn: Conn,
  localpart: string,
): Promise<void> {
  await conn.execute('DELETE FROM account_data WHERE localpart=?', [localpart]);
}

/** Advance a per-tenant counter and return the new value. Three
 * statements inside the caller's write transaction — safe under the
 * store's single-writer-per-file guarantee, no RETURNING dependency. */
export async function nextCounter(conn: Conn, name: string): Promise<number> {
  await conn.execute(
    'INSERT INTO counters (name, value) VALUES (?, 0) ON CONFLICT (name) DO NOTHING',
    [name],
  );
  await conn.execute(
    'UPDATE counters SET value = value + 1 WHERE name = ?',
    [name],
  );
  const rows = await conn.query(
    'SELECT value FROM counters WHERE name = ?',
    [name],
  );
  return Number(rows[0].value);
}

/** The next account-data stream position (the push-rule stream marker
 * takes from the same counter, as the old account_data_seq). */
export function nextStreamSeq(conn: Conn): Promise<number> {
  return nextCounter(conn, 'account_data');
}

// --- conn-level rows (bound on TenantTx) -----------------------------------

async function materializeAccountData(
  conn: Conn,
  localpart: string,
  roomId: string,
  type: string,
  content: string,
  seq: number,
): Promise<void> {
  await conn.execute(
    `INSERT INTO account_data (localpart, room_id, type, content, seq)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (localpart, room_id, type) DO UPDATE SET
       content = excluded.content, seq = excluded.seq`,
    [localpart, roomId, type, content, seq],
  );
}

function semanticKey(localpart: string, room: string, type: string): string {
  return JSON.stringify(['account-data', localpart, room, type]);
}

function address(operation: RegisterOperation): [string, string, string] {
  let parts: unknown;
  try {
    parts = JSON.parse(operation.semanticKey);
  } catch { /* sanitized below */ }
  if (
    !Array.isArray(parts) || parts.length !== 4 ||
    parts[0] !== 'account-data' ||
    parts.slice(1).some((part) => typeof part !== 'string') || !parts[1] ||
    !parts[3] ||
    operation.kind !== (parts[3] === 'm.tag' ? 'tags' : 'account-data') ||
    operation.semanticKey !== semanticKey(parts[1], parts[2], parts[3])
  ) {
    throw new Error('invalid account-data operation');
  }
  return parts.slice(1) as [string, string, string];
}

type TagOperation =
  | { action: 'reset'; content: unknown }
  | { action: 'tag'; tag: string; removed: boolean; value?: unknown };

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function tagOperation(operation: RegisterOperation): TagOperation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(operation.payload);
  } catch {
    throw new Error('invalid tag operation');
  }
  const value = object(parsed);
  if (value.action === 'reset' && Object.hasOwn(value, 'content')) {
    return { action: 'reset', content: value.content };
  }
  if (
    value.action === 'tag' && typeof value.tag === 'string' && value.tag &&
    typeof value.removed === 'boolean' &&
    (value.removed || Object.hasOwn(value, 'value'))
  ) {
    return {
      action: 'tag',
      tag: value.tag,
      removed: value.removed,
      ...(value.removed ? {} : { value: value.value }),
    };
  }
  throw new Error('invalid tag operation');
}

async function activeAccount(conn: Conn, localpart: string): Promise<void> {
  const [user] = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [localpart],
  );
  if (!user) throw new MatrixError(404, 'M_NOT_FOUND', 'unknown user');
  if (user.deactivated === 1) {
    throw new MatrixError(403, 'M_USER_DEACTIVATED', 'account is deactivated');
  }
}

/** The home owns pre-F2 values. Capture its existing value before the first
 * local mutation; an edge must receive that semantic baseline, not invent a
 * second author for an F1 materialization. Whole-scope bootstrap uses the same
 * operation history, and cannot subsequently overwrite a mutable value. */
async function baseline(
  conn: Conn,
  localpart: string,
  room: string,
  type: string,
  incoming?: RegisterOperation,
): Promise<void> {
  const key = semanticKey(localpart, room, type);
  if ((await registerOperations(conn, key)).length) return;
  const held = await accountDataRow(conn, localpart, room, type);
  if (held === null) return;
  const authority = (await tenantAuthority(conn))!;
  if (authority.node !== 'home') {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      'account-data baseline unavailable',
    );
  }
  await captureRegisterBaseline(
    conn,
    { source: authority.node, incarnation: authority.incarnation },
    key,
    type === 'm.tag' ? 'tags' : 'account-data',
    type === 'm.tag'
      ? JSON.stringify({ action: 'reset', content: JSON.parse(held) })
      : held,
    incoming,
  );
}

async function projection(
  conn: Conn,
  key: string,
  tags: boolean,
): Promise<string | null> {
  const view = await readRegister(conn, key);
  if (!view.winner) return null;
  if (!tags) return view.winner.payload;
  const rows = [...view.conflicts, view.winner];
  const decoded = new Map(rows.map((row) => [row, tagOperation(row)]));
  const resets = rows.filter((row) => decoded.get(row)!.action === 'reset');
  const reset = registerWinner(resets, rows);
  const base = reset
    ? (decoded.get(reset)! as { action: 'reset'; content: unknown }).content
    : {};
  if (rows.every((row) => decoded.get(row)!.action === 'reset')) {
    return registerJson(JSON.stringify(base));
  }
  const names = new Set<string>();
  for (const value of decoded.values()) {
    if (value.action === 'tag') names.add(value.tag);
    else {for (const name of Object.keys(object(object(value.content).tags))) {
        names.add(name);
      }}
  }
  const values = new Map<string, unknown>();
  for (const name of names) {
    const winner = registerWinner(
      rows.filter((row) => {
        const value = decoded.get(row)!;
        return value.action === 'reset' || value.tag === name;
      }),
      rows,
    )!;
    const value = decoded.get(winner)!;
    if (value.action === 'tag') {
      if (!value.removed) values.set(name, value.value);
    } else {
      const tags = object(object(value.content).tags);
      if (Object.hasOwn(tags, name)) values.set(name, tags[name]);
    }
  }
  return registerJson(
    JSON.stringify({ ...object(base), tags: Object.fromEntries(values) }),
  );
}

/** The account owner records local semantic intent with the ordinary row. The
 * import path uses the materializer directly, never creating an export echo. */
export async function putAccountDataRow(
  conn: Conn,
  localpart: string,
  room: string,
  type: string,
  content: string,
  seq: number,
): Promise<boolean> {
  const authority = await tenantAuthority(conn);
  if (!authority) {
    await materializeAccountData(conn, localpart, room, type, content, seq);
    return false;
  }
  await activeAccount(conn, localpart);
  await baseline(conn, localpart, room, type);
  const key = semanticKey(localpart, room, type);
  await writeRegister(
    conn,
    { source: authority.node, incarnation: authority.incarnation },
    key,
    type === 'm.tag' ? 'tags' : 'account-data',
    type === 'm.tag'
      ? JSON.stringify({ action: 'reset', content: JSON.parse(content) })
      : content,
  );
  const value = await projection(conn, key, type === 'm.tag');
  const held = await accountDataRow(conn, localpart, room, type);
  if (value !== null && (held === null || registerJson(held) !== value)) {
    await materializeAccountData(conn, localpart, room, type, value, seq);
  }
  return true;
}

export async function accountDataOperations(
  conn: Conn,
  localpart: string,
): Promise<RegisterOperation[]> {
  const rows = await conn.query(
    "SELECT DISTINCT semantic_key FROM domain_operations WHERE kind IN ('account-data','tags') ORDER BY semantic_key",
  );
  const result: RegisterOperation[] = [];
  for (const row of rows) {
    for (
      const operation of await registerOperations(
        conn,
        String(row.semantic_key),
      )
    ) {
      if (address(operation)[0] === localpart) result.push(operation);
    }
  }
  return result;
}

/** Explicit F1 -> F2 capture at the existing value owner. Reads and immutable
 * baseline intents share one tenant cut; bootstrap never restamps account news. */
export async function captureAccountDataOperations(
  conn: Conn,
  localpart: string,
): Promise<RegisterOperation[]> {
  const authority = await tenantAuthority(conn);
  if (authority?.node !== 'home') {
    throw new Error('account-data bootstrap requires home authority');
  }
  await activeAccount(conn, localpart);
  for (
    const row of await conn.query(
      'SELECT room_id,type FROM account_data WHERE localpart=? ORDER BY room_id,type',
      [localpart],
    )
  ) {
    await baseline(conn, localpart, String(row.room_id), String(row.type));
  }
  return await accountDataOperations(conn, localpart);
}

export async function importAccountData(
  conn: Conn,
  operation: RegisterOperation,
): Promise<boolean> {
  const [localpart, room, type] = address(operation),
    authority = await tenantAuthority(conn);
  const allowed = (dot: { source: string; incarnation: string }) =>
    authority &&
    ((dot.source === 'home' && dot.incarnation === authority.homeIncarnation) ||
      (dot.source === authority.edgeNode &&
        dot.incarnation === authority.edgeIncarnation));
  if (
    !allowed(operation) || !Array.isArray(operation.context) ||
    !operation.context.every(allowed)
  ) throw new Error('account-data source unavailable');
  const [user] = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [localpart],
  );
  if (!user) throw new Error('account-data account unavailable');
  if (user.deactivated !== 1 && authority?.node === 'home') {
    await baseline(conn, localpart, room, type, operation);
  }
  if (type === 'm.tag') tagOperation(operation);
  await importRegisterOperation(conn, operation);
  // Retained source evidence must not recreate a deactivated account's data.
  if (user.deactivated === 1) return false;
  const value = await projection(conn, operation.semanticKey, type === 'm.tag');
  const held = await accountDataRow(conn, localpart, room, type);
  if (value === null || (held !== null && registerJson(held) === value)) {
    return false;
  }
  await materializeAccountData(
    conn,
    localpart,
    room,
    type,
    value,
    await nextStreamSeq(conn),
  );
  return true;
}

export async function putRoomTag(
  conn: Conn,
  localpart: string,
  room: string,
  tag: string,
  value?: unknown,
): Promise<{ changed: boolean; recorded: boolean }> {
  const held = await accountDataRow(conn, localpart, room, 'm.tag');
  const authority = await tenantAuthority(conn);
  let content: string;
  if (authority) {
    await activeAccount(conn, localpart);
    await baseline(conn, localpart, room, 'm.tag');
    const key = semanticKey(localpart, room, 'm.tag');
    await writeRegister(
      conn,
      { source: authority.node, incarnation: authority.incarnation },
      key,
      'tags',
      JSON.stringify({
        action: 'tag',
        tag,
        removed: value === undefined,
        ...(value === undefined ? {} : { value }),
      }),
    );
    content = (await projection(conn, key, true))!;
  } else {
    const current = held === null ? {} : object(JSON.parse(held));
    const tags = new Map(Object.entries(object(current.tags)));
    if (value === undefined) {
      if (!tags.delete(tag)) return { changed: false, recorded: false };
    } else tags.set(tag, value);
    content = JSON.stringify({ ...current, tags: Object.fromEntries(tags) });
  }
  if (
    authority && held !== null && registerJson(held) === registerJson(content)
  ) {
    return { changed: false, recorded: !!authority };
  }
  await materializeAccountData(
    conn,
    localpart,
    room,
    'm.tag',
    content,
    await nextStreamSeq(conn),
  );
  return { changed: true, recorded: !!authority };
}

export async function accountDataRow(
  conn: Conn,
  localpart: string,
  roomId: string,
  type: string,
): Promise<string | null> {
  const rows = await conn.query(
    'SELECT content FROM account_data WHERE localpart = ? AND room_id = ? AND type = ?',
    [localpart, roomId, type],
  );
  return rows.length === 0 ? null : String(rows[0].content);
}

export type AccountDataRow = {
  type: string;
  content: unknown;
};

/** A value and its revision from the same owning transaction. */
export async function accountDataSnapshot(
  conn: Conn,
  localpart: string,
  roomId: string,
  type: string,
): Promise<{ content: unknown; seq: number } | null> {
  const rows = await conn.query(
    'SELECT content,seq FROM account_data WHERE localpart=? AND room_id=? AND type=?',
    [localpart, roomId, type],
  );
  return rows.length
    ? { content: JSON.parse(String(rows[0].content)), seq: Number(rows[0].seq) }
    : null;
}

// List filtering consumes immutable values captured with their owning cut.
// Only m.tag is read here, never unrelated room account-data payloads.
export async function listSelectionSnapshot(conn: Conn, localpart: string) {
  const direct = await accountDataSnapshot(conn, localpart, '', 'm.direct');
  const ignored = await accountDataSnapshot(
    conn,
    localpart,
    '',
    'm.ignored_user_list',
  );
  const tags = new Map((await conn.query(
    "SELECT room_id,content FROM account_data WHERE localpart=? AND type='m.tag' AND room_id<>''",
    [localpart],
  )).map((r) => [String(r.room_id), JSON.parse(String(r.content)) as unknown]));
  return {
    accountCut: await accountDataMaxSeq(conn, localpart),
    direct: direct?.content,
    ignored: ignored?.content,
    tags,
  };
}

function toAccountDataRows(
  rows: Record<string, unknown>[],
): AccountDataRow[] {
  return rows.map((row) => ({
    type: String(row.type),
    content: JSON.parse(String(row.content)),
  }));
}

export async function accountDataOfRoom(
  conn: Conn,
  localpart: string,
  roomId: string,
  since = -1,
  until = Number.MAX_SAFE_INTEGER,
): Promise<AccountDataRow[]> {
  return toAccountDataRows(
    await conn.query(
      'SELECT type,content FROM account_data WHERE localpart=? AND room_id=? AND seq>? AND seq<=? ORDER BY seq',
      [localpart, roomId, since, until],
    ),
  );
}

export async function globalAccountDataSince(
  conn: Conn,
  localpart: string,
  aSeq: number,
): Promise<AccountDataRow[]> {
  return await accountDataOfRoom(conn, localpart, '', aSeq);
}

export async function accountDataMaxSeq(
  conn: Conn,
  localpart: string,
): Promise<number> {
  const rows = await conn.query(
    'SELECT MAX(seq) AS m FROM account_data WHERE localpart = ?',
    [localpart],
  );
  return rows[0].m == null ? 0 : Number(rows[0].m);
}

export async function roomAccountDataSince(
  conn: Conn,
  localpart: string,
  since: number,
  until: number,
): Promise<Map<string, AccountDataRow[]>> {
  const rows = await conn.query(
    "SELECT room_id,type,content FROM account_data WHERE localpart=? AND room_id<>'' AND seq>? AND seq<=? ORDER BY seq",
    [localpart, since, until],
  );
  const rooms = new Map<string, AccountDataRow[]>();
  for (const row of rows) {
    const room = String(row.room_id);
    const events = rooms.get(room) ?? [];
    events.push({
      type: String(row.type),
      content: JSON.parse(String(row.content)),
    });
    rooms.set(room, events);
  }
  return rooms;
}

/** Bounded set reads avoid a round trip per membership. Empty arrays are
 * deliberate capture proofs: an absent room was not read and cannot advance. */
export async function selectedAccountDataSince(
  conn: Conn,
  localpart: string,
  selected: ReadonlyMap<string, number>,
  until: number,
): Promise<Map<string, AccountDataRow[]>> {
  const rooms = new Map<string, AccountDataRow[]>(
    [...selected.keys()].map((id) => [id, []]),
  );
  const ids = [...selected.keys()];
  for (let offset = 0; offset < ids.length; offset += 256) {
    const batch = ids.slice(offset, offset + 256);
    const since = Math.min(...batch.map((id) => selected.get(id)!));
    const rows = await conn.query(
      `SELECT room_id,type,content,seq FROM account_data WHERE localpart=?
       AND room_id<>'' AND room_id IN (${batch.map(() => '?').join(',')})
       AND seq>? AND seq<=? ORDER BY seq`,
      [localpart, ...batch, since, until],
    );
    for (const row of rows) {
      const room = String(row.room_id);
      if (Number(row.seq) <= selected.get(room)!) continue;
      rooms.get(room)!.push({
        type: String(row.type),
        content: JSON.parse(String(row.content)),
      });
    }
  }
  return rooms;
}

/** Bodies and the cursor describing them belong to one tenant snapshot. A
 * selected room has its own last delivered cut; a connection's global cut must
 * not skip data while that room was outside the extension window. Undefined
 * rooms preserves ordinary sync's all-room delta; an empty map selects none. */
export async function captureAccountData(
  tx: TenantTx,
  localpart: string,
  serverName: string,
  since: number | null,
  selected?: ReadonlyMap<string, number>,
): Promise<{
  seq: number;
  global: AccountDataRow[];
  rooms: Map<string, AccountDataRow[]>;
}> {
  const pushSeq = await tx.pushRules.streamSeq(localpart);
  const seq = Math.max(await tx.accountData.maxSeq(localpart), pushSeq);
  const global = await tx.accountData.ofRoom(localpart, '', since ?? -1, seq);
  if (since === null || pushSeq > since) {
    global.push({
      type: 'm.push_rules',
      content: { global: await rulesetAt(tx, localpart, serverName) },
    });
  }
  const rooms = selected === undefined
    ? await tx.accountData.roomsSince(localpart, since ?? -1, seq)
    : await tx.accountData.selectedSince(localpart, selected, seq);
  return { seq, global, rooms };
}

/** Tags and ordinary m.tag writes share one row and one stream. Read/modify/write
 * stays entirely in the tenant transaction, including retry-local objects. */
export async function updateRoomTag(
  tenant: Tenant,
  localpart: string,
  roomId: string,
  tag: string,
  value?: unknown,
): Promise<void> {
  await tenant.tx((tx) => tx.accountData.tag(localpart, roomId, tag, value));
}

// --- tenant-level behaviour --------------------------------------------------

/** Upsert account data. roomId '' = global. The write and its stream
 * stamp are one tenant transaction (D10). */
export async function putAccountData(
  tenant: Tenant,
  localpart: string,
  roomId: string,
  type: string,
  content: unknown,
): Promise<void> {
  await tenant.tx(async (tx) => {
    const seq = await tx.counters.nextStream();
    await tx.accountData.put(
      localpart,
      roomId,
      type,
      JSON.stringify(content),
      seq,
    );
  });
}

/** The stored content object, or null when unset. */
export async function getAccountData(
  tenant: Tenant,
  localpart: string,
  roomId: string,
  type: string,
): Promise<unknown | null> {
  const content = await tenant.tx((tx) =>
    tx.accountData.get(localpart, roomId, type)
  );
  return content === null ? null : JSON.parse(content);
}

/** M4: the user's GLOBAL account data rows (room_id '') as {type, content}. */
export async function listGlobalAccountData(
  tenant: Tenant,
  localpart: string,
): Promise<AccountDataRow[]> {
  return await tenant.tx((tx) => tx.accountData.ofRoom(localpart, ''));
}

/** Band C: the user's account data rows FOR ONE ROOM as {type, content}. */
export async function listRoomAccountData(
  tenant: Tenant,
  localpart: string,
  roomId: string,
): Promise<AccountDataRow[]> {
  return await tenant.tx((tx) => tx.accountData.ofRoom(localpart, roomId));
}

// D10: global account-data rows changed since a stream position
// (incremental syncs; initial syncs use listGlobalAccountData).
export async function listGlobalAccountDataSince(
  tenant: Tenant,
  localpart: string,
  aSeq: number,
): Promise<AccountDataRow[]> {
  return await tenant.tx((tx) => tx.accountData.globalSince(localpart, aSeq));
}

// D10: the syncer's account-data stream position (max seq over account
// data and the push-rule stream marker — both ride the same counter).
export async function accountDataMax(
  tenant: Tenant,
  localpart: string,
): Promise<number> {
  return await tenant.tx(async (tx) => {
    const data = await tx.accountData.maxSeq(localpart);
    const push = await tx.pushRules.streamSeq(localpart);
    return Math.max(data, push);
  });
}
