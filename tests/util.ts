import { headExtremity, lookupRoom } from '#engine/room.ts';
import { serverDb, withDb } from '#engine/db.ts';

// Head extremity's wire event_id: greatest tip depth, tie → smallest
// event_id (content-based, deterministic; soft-failed/rejected excluded).
export async function latestExtremityEventId(roomId: string): Promise<string> {
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  const head = await headExtremity(room.dbName, roomId);
  if (!head) throw new Error('no extremity branches');
  return head.eventId;
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
