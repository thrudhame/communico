// api/engine/user-directory.ts — band C item 5 (D6): POST
// /user_directory/search over the users visible to the searcher (spec
// v1.16 users.yaml:22-39): users joined to a PUBLIC room (directory
// visibility or public join rule) plus users sharing a joined room with
// the searcher, minus the searcher. Match is a case-insensitive
// substring on the user id or the GLOBAL display name — room-specific
// names are never searched and never returned (the Synapse #5677
// regression test, Complement user_directory_display_names_test.go).
// Computed live from room_membership + tenant users — small server, no
// separate index.
import { serverDb, withDb } from './db.ts';
import { serverName } from './config.ts';
import { localpartOf } from './auth.ts';
import { stateAtSeq } from './room.ts';
import { getProfile } from './tenant.ts';

export interface UserDirectoryResult {
  user_id: string;
  display_name?: string;
  avatar_url?: string;
}

async function publicRoomIds(): Promise<string[]> {
  const listed = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      `SELECT room_id FROM room_visibility WHERE visibility = 'public';`,
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => String(row.room_id));
  });
  // Plus rooms whose CURRENT join rule is public (read live — no index)
  const all = await withDb(serverDb(), async (c) => {
    const r = await c.query('SELECT DISTINCT room_id FROM room_membership;');
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => String(row.room_id));
  });
  const out = new Set(listed);
  for (const roomId of all) {
    if (out.has(roomId)) continue;
    const rows = (await stateAtSeq(roomId, null)) ?? [];
    const jr = rows.find(
      (r) => r.type === 'm.room.join_rules' && r.stateKey === '',
    );
    if (
      ((jr?.content ?? {}) as Record<string, unknown>).join_rule === 'public'
    ) {
      out.add(roomId);
    }
  }
  return [...out];
}

export async function searchUsers(
  searcher: string,
  term: string,
  limit = 10,
): Promise<{ results: UserDirectoryResult[]; limited: boolean }> {
  const publicRooms = await publicRoomIds();
  const candidates = await withDb(serverDb(), async (c) => {
    const shared = await c.query(
      `SELECT DISTINCT rm2.user_id AS u FROM room_membership rm1
       JOIN room_membership rm2 ON rm1.room_id = rm2.room_id
       WHERE rm1.user_id = $1 AND rm1.membership = 'join' AND rm2.membership = 'join';`,
      [searcher],
    );
    const set = new Set(
      // deno-lint-ignore no-explicit-any
      (shared.rows as any[]).map((row) => String(row.u)),
    );
    for (const roomId of publicRooms) {
      const rows = await c.query(
        `SELECT user_id FROM room_membership WHERE room_id = $1 AND membership = 'join';`,
        [roomId],
      );
      // deno-lint-ignore no-explicit-any
      for (const row of rows.rows as any[]) set.add(String(row.user_id));
    }
    return set;
  });
  candidates.delete(searcher);

  const needle = term.toLowerCase();
  const results: UserDirectoryResult[] = [];
  for (const userId of candidates) {
    if (!userId.endsWith(':' + serverName())) continue; // local users only
    const profile = await getProfile(serverName(), localpartOf(userId));
    const displayName = profile?.displayname;
    if (
      !userId.toLowerCase().includes(needle) &&
      !(displayName !== undefined &&
        displayName.toLowerCase().includes(needle))
    ) {
      continue;
    }
    const result: UserDirectoryResult = { user_id: userId };
    if (displayName !== undefined) result.display_name = displayName;
    if (profile?.avatar_url !== undefined) {
      result.avatar_url = profile.avatar_url;
    }
    results.push(result);
  }
  results.sort((a, b) => a.user_id.localeCompare(b.user_id));
  const limited = results.length > limit;
  return { results: results.slice(0, limit), limited };
}
