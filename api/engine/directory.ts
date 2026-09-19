// api/engine/directory.ts — band C item 1: the public room directory
// (plan §2, spec v1.16 list_public_rooms.yaml). Listing source is the
// room_visibility rows (M4) joined live with each room's `main` state —
// small server, no separate index. Rooms are ordered by joined-member
// count, largest first (list_public_rooms.yaml:136-137).
import { serverDb, withDb } from './db.ts';
import { MatrixError } from './matrix-error.ts';
import { lookupRoom, membershipOf, stateAtSeq } from './room.ts';

export interface PublicRoomChunk {
  room_id: string;
  name?: string;
  topic?: string;
  canonical_alias?: string;
  num_joined_members: number;
  world_readable: boolean;
  guest_can_join: boolean;
  join_rule?: string;
  avatar_url?: string;
}

export interface PublicRoomsResult {
  chunk: PublicRoomChunk[];
  total_room_count_estimate: number;
  next_batch?: string;
  prev_batch?: string;
}

function stateString(
  rows: { type: string; stateKey: string; content: unknown }[],
  type: string,
  key: string,
): string | undefined {
  const row = rows.find((r) => r.type === type && r.stateKey === '');
  const v = row ? (row.content as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' ? v : undefined;
}

export async function publicRooms(opts: {
  search?: string;
  limit?: number;
  since?: string;
}): Promise<PublicRoomsResult> {
  const limit = opts.limit !== undefined && opts.limit > 0 ? opts.limit : 100;
  const offset = opts.since !== undefined
    ? Math.max(0, Number.parseInt(opts.since, 10) || 0)
    : 0;
  const roomIds = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      `SELECT room_id FROM room_visibility WHERE visibility = 'public';`,
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => String(row.room_id));
  });

  const needle = opts.search?.toLowerCase();
  const all: PublicRoomChunk[] = [];
  for (const roomId of roomIds) {
    const rows = (await stateAtSeq(roomId, null)) ?? [];
    const name = stateString(rows, 'm.room.name', 'name');
    const topic = stateString(rows, 'm.room.topic', 'topic');
    const canonical = stateString(rows, 'm.room.canonical_alias', 'alias');
    if (needle !== undefined) {
      const hay = [name, topic, canonical].filter((s) =>
        s !== undefined
      ) as string[];
      if (!hay.some((s) => s.toLowerCase().includes(needle))) continue;
    }
    const joined = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        `SELECT count(*) AS n FROM room_membership WHERE room_id = $1 AND membership = 'join';`,
        [roomId],
      );
      return Number(r.rows[0].n);
    });
    const joinRule = stateString(rows, 'm.room.join_rules', 'join_rule');
    const chunk: PublicRoomChunk = {
      room_id: roomId,
      num_joined_members: joined,
      world_readable:
        stateString(rows, 'm.room.history_visibility', 'history_visibility') ===
          'world_readable',
      guest_can_join:
        stateString(rows, 'm.room.guest_access', 'guest_access') ===
          'can_join',
    };
    if (name !== undefined) chunk.name = name;
    if (topic !== undefined) chunk.topic = topic;
    if (canonical !== undefined) chunk.canonical_alias = canonical;
    if (joinRule !== undefined) chunk.join_rule = joinRule;
    const avatar = stateString(rows, 'm.room.avatar', 'url');
    if (avatar !== undefined) chunk.avatar_url = avatar;
    all.push(chunk);
  }

  all.sort((a, b) =>
    b.num_joined_members - a.num_joined_members ||
    a.room_id.localeCompare(b.room_id)
  );
  const chunk = all.slice(offset, offset + limit);
  const out: PublicRoomsResult = {
    chunk,
    total_room_count_estimate: all.length,
  };
  if (offset + limit < all.length) out.next_batch = String(offset + limit);
  if (offset > 0) out.prev_batch = String(Math.max(0, offset - limit));
  return out;
}

// GET /directory/list/room/{roomId} — PUBLIC (list_public_rooms.yaml's
// get carries no security block). Unknown room → 404 M_NOT_FOUND.
export async function getVisibility(
  roomId: string,
): Promise<{ visibility: string }> {
  if (!(await lookupRoom(roomId))) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'Room not found');
  }
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT visibility FROM room_visibility WHERE room_id = $1;',
      [roomId],
    );
    return {
      visibility: r.rows.length ? String(r.rows[0].visibility) : 'private',
    };
  });
}

// PUT /directory/list/room/{roomId} — the requester must be joined
// (plan §2). Toggles the room_visibility row the listing reads.
export async function setVisibility(
  roomId: string,
  requester: string,
  visibility: string,
): Promise<void> {
  if (!(await lookupRoom(roomId))) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'Room not found');
  }
  if (visibility !== 'public' && visibility !== 'private') {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'unknown visibility: ' + visibility,
    );
  }
  if ((await membershipOf(roomId, requester))?.membership !== 'join') {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'You are not a member of the room.',
    );
  }
  await withDb(serverDb(), async (c) => {
    await c.query('DELETE FROM room_visibility WHERE room_id = $1;', [roomId]);
    if (visibility === 'public') {
      await c.query(
        `INSERT INTO room_visibility (room_id, visibility) VALUES ($1, 'public');`,
        [roomId],
      );
    }
  });
}
