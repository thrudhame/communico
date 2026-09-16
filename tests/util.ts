import { lookupRoom } from '#engine/room.ts';
import { ident, serverDb, withDb } from '#engine/db.ts';

// Newest extremity's wire event_id: newest-tipped x* branch in the room
// DB -> its tip hash -> event_index (D8: branch tip == event commit).
export async function latestExtremityEventId(roomId: string): Promise<string> {
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  return await withDb(room.dbName, async (c) => {
    const b = await c.query(
      `SELECT name FROM dolt.branches WHERE name LIKE 'x%'
       ORDER BY latest_commit_date DESC, name ASC LIMIT 1;`,
    );
    if (b.rows.length === 0) throw new Error('no extremity branches');
    const branch = String(b.rows[0].name);
    const h = await c.query(
      `SELECT (SELECT HASHOF('${ident(branch)}')) AS h;`,
    );
    const tipHash = String(h.rows[0].h);
    return await withDb(serverDb(), async (s) => {
      const r = await s.query(
        'SELECT event_id FROM event_index WHERE room_id = $1 AND commit_hash = $2;',
        [roomId, tipHash],
      );
      if (r.rows.length === 0) throw new Error('tip not in event_index');
      return String(r.rows[0].event_id);
    });
  });
}

// Drops the room DB + server rows so content-addressed test rooms can be
// re-created on reruns.
export async function resetRoom(roomId: string): Promise<void> {
  const { dbNameFor } = await import('#engine/room.ts');
  const dbName = await dbNameFor(roomId);
  await withDb(serverDb(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${dbName};`);
    await c.query('DELETE FROM room_directory WHERE room_id = $1;', [roomId]);
    await c.query('DELETE FROM event_index WHERE room_id = $1;', [roomId]);
  });
}

// --- M2 test helpers (plan §3.8) -------------------------------------------

/** Wipe every tenant row for a localpart so wire tests re-register cleanly
 * on reruns (the tenant.test.ts lifecycle pattern, extended to the M2
 * tables). Children first — pushers references users AND access_tokens. */
export async function resetUser(localpart: string): Promise<void> {
  const { ensureTenant } = await import('#engine/tenant.ts');
  const { serverName } = await import('#engine/config.ts');
  const { dbName } = await ensureTenant(serverName());
  const lp = localpart.toLowerCase();
  await withDb(dbName, async (c) => {
    await c.query('DELETE FROM pushers WHERE localpart = $1;', [lp]);
    await c.query('DELETE FROM account_data WHERE localpart = $1;', [lp]);
    await c.query('DELETE FROM media WHERE localpart = $1;', [lp]);
    await c.query('DELETE FROM access_tokens WHERE localpart = $1;', [lp]);
    await c.query('DELETE FROM devices WHERE localpart = $1;', [lp]);
    await c.query('DELETE FROM credentials WHERE localpart = $1;', [lp]);
    await c.query('DELETE FROM users WHERE localpart = $1;', [lp]);
  });
}

/** Clean-slate register: resetUser, then registerUser. */
export async function registerTestUser(localpart: string, password: string) {
  await resetUser(localpart);
  const { registerUser } = await import('#engine/tenant.ts');
  const { serverName } = await import('#engine/config.ts');
  return await registerUser(serverName(), { localpart, password });
}
