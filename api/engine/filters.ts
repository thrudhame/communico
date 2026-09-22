// api/engine/filters.ts — M4 /sync filters (plan §2): store/load in the
// tenant DB; resolveFilter accepts a filter id OR inline JSON (a leading
// '{' distinguishes, per the spec's client guidance); the typed
// RoomFilter carries timeline.limit/types/not_types/lazy_load_members,
// state.types/not_types/lazy_load_members and include_leave. Unknown
// keys are ignored.
import { serverName } from './config.ts';
import { localpartOf } from './auth.ts';
import { MatrixError } from './matrix-error.ts';
import { ensureTenant } from './tenant.ts';
import { withDb } from './db.ts';

export interface EventFilter {
  limit?: number;
  types?: string[];
  not_types?: string[];
  lazy_load_members?: boolean;
}

export interface RoomFilter {
  timeline: EventFilter;
  state: EventFilter;
  includeLeave: boolean;
}

export const DEFAULT_ROOM_FILTER: RoomFilter = {
  timeline: {},
  state: {},
  includeLeave: false,
};

// Validate a filter document's SHAPE at store time (spec filter.yaml at
// v1.16; Complement invalid_test.go's TestFilter): known keys must carry
// their spec'd types — presence/account_data/room and room's sub-filters
// are objects; the list fields are arrays of strings (rooms/not_rooms
// entries are room ids or aliases, senders/not_senders entries are user
// ids); limit is a non-negative integer. Unknown keys are ignored.
export function validateFilterDocument(raw: unknown): void {
  const bad = (what: string) =>
    new MatrixError(400, 'M_BAD_JSON', 'invalid filter: ' + what);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw bad('not an object');
  }
  const doc = raw as Record<string, unknown>;
  for (const key of ['presence', 'account_data', 'room']) {
    const v = doc[key];
    if (
      v !== undefined &&
      (v === null || typeof v !== 'object' || Array.isArray(v))
    ) {
      throw bad(key + ' is not an object');
    }
  }
  const room = (doc.room ?? {}) as Record<string, unknown>;
  for (const key of ['timeline', 'state', 'ephemeral', 'account_data']) {
    const v = room[key];
    if (
      v !== undefined &&
      (v === null || typeof v !== 'object' || Array.isArray(v))
    ) {
      throw bad('room.' + key + ' is not an object');
    }
  }
  const checkSection = (section: unknown, name: string) => {
    if (section === undefined) return;
    const s = section as Record<string, unknown>;
    for (
      const key of [
        'rooms',
        'not_rooms',
        'senders',
        'not_senders',
        'types',
        'not_types',
      ] as const
    ) {
      const v = s[key];
      if (v === undefined) continue;
      if (!Array.isArray(v)) throw bad(name + '.' + key + ' is not a list');
      for (const e of v) {
        if (typeof e !== 'string') {
          throw bad(name + '.' + key + ' entries must be strings');
        }
        if (
          (key === 'rooms' || key === 'not_rooms') &&
          !e.startsWith('!') && !e.startsWith('#')
        ) {
          throw bad(name + '.' + key + ' entry is not a room id: ' + e);
        }
        if (
          (key === 'senders' || key === 'not_senders') && !e.startsWith('@')
        ) {
          throw bad(name + '.' + key + ' entry is not a user id: ' + e);
        }
      }
    }
    if (
      s.limit !== undefined &&
      (typeof s.limit !== 'number' || !Number.isInteger(s.limit) || s.limit < 0)
    ) {
      throw bad(name + '.limit is not a non-negative integer');
    }
  };
  for (const section of ['timeline', 'state', 'ephemeral', 'account_data']) {
    checkSection(room[section], 'room.' + section);
  }
}

function eventFilterOf(raw: unknown): EventFilter {
  const out: EventFilter = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.limit === 'number' && Number.isInteger(r.limit) && r.limit >= 0
  ) {
    out.limit = r.limit;
  }
  if (Array.isArray(r.types) && r.types.every((t) => typeof t === 'string')) {
    out.types = r.types as string[];
  }
  if (
    Array.isArray(r.not_types) &&
    r.not_types.every((t) => typeof t === 'string')
  ) {
    out.not_types = r.not_types as string[];
  }
  if (typeof r.lazy_load_members === 'boolean') {
    out.lazy_load_members = r.lazy_load_members;
  }
  return out;
}

// Parse a filter document (already-JSON-decoded) into the typed shape.
export function roomFilterOf(raw: unknown): RoomFilter {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULT_ROOM_FILTER;
  }
  const r = raw as Record<string, unknown>;
  const room = (r.room ?? {}) as Record<string, unknown>;
  return {
    timeline: eventFilterOf(room.timeline),
    state: eventFilterOf(room.state),
    includeLeave: room.include_leave === true,
  };
}

/** Store a filter document for the user; returns the new filter_id. */
export async function storeFilter(
  server: string,
  localpart: string,
  filter: unknown,
): Promise<string> {
  const { dbName } = await ensureTenant(server);
  return await withDb(dbName, async (c) => {
    const n = await c.query(
      'SELECT COUNT(*) AS n FROM filters WHERE localpart = $1;',
      [localpart],
    );
    const filterId = String(Number(n.rows[0].n));
    await c.query(
      'INSERT INTO filters (localpart, filter_id, filter) VALUES ($1, $2, $3);',
      [localpart, filterId, JSON.stringify(filter)],
    );
    return filterId;
  });
}

/** The stored filter document verbatim, or null. */
export async function loadFilter(
  server: string,
  localpart: string,
  filterId: string,
): Promise<unknown | null> {
  const { dbName } = await ensureTenant(server);
  return await withDb(dbName, async (c) => {
    const r = await c.query(
      'SELECT filter FROM filters WHERE localpart = $1 AND filter_id = $2;',
      [localpart, filterId],
    );
    if (r.rows.length === 0) return null;
    const v = r.rows[0].filter;
    return typeof v === 'string' ? JSON.parse(v) : v;
  });
}

// Resolve the /sync `filter` parameter: absent -> the default; a leading
// '{' -> inline JSON; otherwise a stored filter id (own user only).
export async function resolveFilter(
  userId: string,
  raw: string | null,
): Promise<RoomFilter> {
  if (raw === null || raw === '') return DEFAULT_ROOM_FILTER;
  if (raw.startsWith('{')) {
    try {
      return roomFilterOf(JSON.parse(raw));
    } catch {
      throw new MatrixError(400, 'M_BAD_JSON', 'filter is not valid JSON');
    }
  }
  const doc = await loadFilter(serverName(), localpartOf(userId), raw);
  if (doc === null) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'unknown filter: ' + raw);
  }
  return roomFilterOf(doc);
}

// RoomEventFilter (room_event_filter.yaml + event_filter.yaml at v1.16)
// as applied to a single event. rooms/not_rooms are a room-scope concern
// (search D3); this predicate covers types/senders/contains_url.
export interface RoomEventFilter {
  limit?: number;
  types?: string[];
  not_types?: string[];
  senders?: string[];
  not_senders?: string[];
  rooms?: string[];
  not_rooms?: string[];
  contains_url?: boolean;
}

export function roomEventFilterOf(raw: unknown): RoomEventFilter {
  const out: RoomEventFilter = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.limit === 'number' && Number.isInteger(r.limit) && r.limit > 0
  ) {
    out.limit = r.limit;
  }
  const strList = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((e) => typeof e === 'string')
      ? v as string[]
      : undefined;
  const types = strList(r.types);
  if (types) out.types = types;
  const notTypes = strList(r.not_types);
  if (notTypes) out.not_types = notTypes;
  const senders = strList(r.senders);
  if (senders) out.senders = senders;
  const notSenders = strList(r.not_senders);
  if (notSenders) out.not_senders = notSenders;
  const rooms = strList(r.rooms);
  if (rooms) out.rooms = rooms;
  const notRooms = strList(r.not_rooms);
  if (notRooms) out.not_rooms = notRooms;
  if (typeof r.contains_url === 'boolean') out.contains_url = r.contains_url;
  return out;
}

export function eventMatchesRoomEventFilter(
  _row: unknown,
  pdu: { type: string; sender: string; content?: Record<string, unknown> },
  filter: RoomEventFilter,
): boolean {
  if (filter.types !== undefined && !filter.types.includes(pdu.type)) {
    return false;
  }
  if (
    filter.not_types !== undefined && filter.not_types.includes(pdu.type)
  ) {
    return false;
  }
  if (
    filter.senders !== undefined && !filter.senders.includes(pdu.sender)
  ) {
    return false;
  }
  if (
    filter.not_senders !== undefined &&
    filter.not_senders.includes(pdu.sender)
  ) {
    return false;
  }
  if (filter.contains_url !== undefined) {
    const hasUrl =
      typeof ((pdu.content ?? {}) as Record<string, unknown>).url === 'string';
    if (hasUrl !== filter.contains_url) return false;
  }
  return true;
}
