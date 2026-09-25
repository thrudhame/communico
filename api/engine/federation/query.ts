// api/engine/federation/query.ts — helpers for the lookups/answer-from-held
// surface: a REMOTE user's profile from member events in rooms we hold
// (no outbound request — not a proxy). Deviation: the M5a plan's scope
// names aliases.ts for the alias helper and no module for the profile
// helper; the two lookups live here.
import { serverDb, withDb } from '#engine/db.ts';
import { lookupRoom } from '#engine/room.ts';

export async function remoteUserFromMembers(
  userId: string,
): Promise<{ displayname?: string; avatar_url?: string } | null> {
  // any member event of that user in a room we hold
  const ev = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT room_id, event_id FROM room_membership WHERE user_id = $1 LIMIT 1;',
      [userId],
    );
    if (r.rows.length === 0) return null;
    const o = r.rows[0] as Record<string, unknown>;
    return { roomId: String(o.room_id), eventId: String(o.event_id) };
  });
  if (ev === null) return null;
  const room = await lookupRoom(ev.roomId);
  if (!room) return null;
  return await withDb(room.dbName, async (c) => {
    const r = await c.query(
      'SELECT canonical_json FROM events WHERE event_id = $1;',
      [ev.eventId],
    );
    if (r.rows.length === 0) return null;
    const doc = JSON.parse(
      String((r.rows[0] as Record<string, unknown>).canonical_json),
    ) as Record<string, unknown>;
    const content = doc.content as Record<string, unknown> | undefined;
    const out: { displayname?: string; avatar_url?: string } = {};
    if (content !== undefined) {
      if (typeof content.displayname === 'string') {
        out.displayname = content.displayname;
      }
      if (typeof content.avatar_url === 'string') {
        out.avatar_url = content.avatar_url;
      }
    }
    return out;
  });
}
