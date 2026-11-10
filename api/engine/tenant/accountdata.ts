// api/engine/tenant/accountdata.ts — account data (M2): global rows
// (room_id '') and per-room rows, each write stamped with the next stream
// position (D10: the sync token's _a<n> moves, incremental syncs deliver
// rows with seq > the token, long-polls wake). The old account_data_seq
// sequence is the 'account_data' row of `counters`, advanced inside the
// same tenant transaction as the write it stamps; the push-rule stream
// marker rides the same counter.
import type { Conn } from '#engine/store/db.ts';
import type { Tenant } from '#engine/tenant/index.ts';
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

export async function putAccountDataRow(
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
): Promise<AccountDataRow[]> {
  return toAccountDataRows(
    await conn.query(
      'SELECT type, content FROM account_data WHERE localpart = ? AND room_id = ?',
      [localpart, roomId],
    ),
  );
}

export async function globalAccountDataSince(
  conn: Conn,
  localpart: string,
  aSeq: number,
): Promise<AccountDataRow[]> {
  return toAccountDataRows(
    await conn.query(
      "SELECT type, content FROM account_data WHERE localpart = ? AND room_id = '' AND seq > ? ORDER BY seq ASC",
      [localpart, aSeq],
    ),
  );
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

/** Tags and ordinary m.tag writes share one row and one stream. Read/modify/write
 * stays entirely in the tenant transaction, including retry-local objects. */
export async function updateRoomTag(
  tenant: Tenant,
  localpart: string,
  roomId: string,
  tag: string,
  value?: unknown,
): Promise<void> {
  await tenant.tx(async (tx) => {
    const raw = await tx.accountData.get(localpart, roomId, 'm.tag');
    const content = raw === null ? {} : JSON.parse(raw);
    const current = content.tags;
    const tags = new Map<string, unknown>(
      current !== null && typeof current === 'object' && !Array.isArray(current)
        ? Object.entries(current)
        : [],
    );
    if (value === undefined) {
      if (!tags.delete(tag)) return;
    } else tags.set(tag, value);
    await tx.accountData.put(
      localpart,
      roomId,
      'm.tag',
      JSON.stringify({ ...content, tags: Object.fromEntries(tags) }),
      await tx.counters.nextStream(),
    );
  });
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
