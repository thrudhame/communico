// Validate before touching a connection. Unknown extensions remain interoperable.
import { MatrixError } from '#engine/matrix-error.ts';
import type {
  Extensions,
  ListConfig,
  ListFilters,
  RoomConfig,
  SlidingRequest,
} from './types.ts';

function invalid(label: string): never {
  throw new MatrixError(400, 'M_INVALID_PARAM', 'invalid ' + label);
}
function object(raw: unknown, label: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    invalid(label);
  }
  return raw as Record<string, unknown>;
}
function integer(
  raw: unknown,
  label: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 ||
    raw > max
  ) invalid(label);
  return raw;
}
function boolean(raw: unknown, label: string): boolean {
  if (typeof raw !== 'boolean') invalid(label);
  return raw;
}
function string(raw: unknown, label: string): string {
  if (typeof raw !== 'string') invalid(label);
  return raw;
}
function strings(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) invalid(label);
  return raw.map((v) => string(v, label));
}
function roomConfig(raw: unknown): RoomConfig {
  const body = object(raw, 'room config');
  if (!Array.isArray(body.required_state)) invalid('required_state');
  return {
    requiredState: body.required_state.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) invalid('required_state');
      return [string(pair[0], 'state type'), string(pair[1], 'state key')];
    }),
    timelineLimit: integer(body.timeline_limit, 'timeline_limit', 1000),
  };
}
function filters(raw: unknown): ListFilters {
  const body = object(raw ?? {}, 'filters'), out: ListFilters = {};
  for (const key of ['is_dm', 'is_encrypted', 'is_invite'] as const) {
    if (body[key] != null) out[key] = boolean(body[key], key);
  }
  for (const key of ['spaces', 'tags', 'not_tags'] as const) {
    if (body[key] != null) out[key] = strings(body[key], key);
  }
  for (const key of ['room_types', 'not_room_types'] as const) {
    if (body[key] == null) continue;
    if (!Array.isArray(body[key])) invalid(key);
    out[key] = body[key].map((v) => v === null ? null : string(v, key));
  }
  if (body.room_name_like != null) {
    out.room_name_like = string(body.room_name_like, 'room_name_like');
  }
  return out;
}
function listConfig(raw: unknown): ListConfig {
  const body = object(raw, 'list');
  let ranges: [number, number][] | null = null;
  if (body.ranges != null) {
    if (!Array.isArray(body.ranges)) invalid('ranges');
    ranges = body.ranges.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) invalid('range');
      const start = integer(pair[0], 'range start'),
        end = integer(pair[1], 'range end');
      if (start > end) invalid('range order');
      return [start, end];
    });
  }
  return {
    ...roomConfig(body),
    ranges,
    allRooms: body.slow_get_all_rooms == null
      ? false
      : boolean(body.slow_get_all_rooms, 'slow_get_all_rooms'),
    filters: filters(body.filters),
  };
}
function extensions(raw: unknown): Extensions {
  const body = object(raw ?? {}, 'extensions'), out: Extensions = {};
  if (body.e2ee != null) {
    const ext = object(body.e2ee, 'e2ee');
    out.e2ee = {
      enabled: ext.enabled == null ? false : boolean(ext.enabled, 'enabled'),
    };
  }
  if (body.to_device != null) {
    const ext = object(body.to_device, 'to_device');
    out.to_device = {
      enabled: ext.enabled == null ? false : boolean(ext.enabled, 'enabled'),
      limit: ext.limit == null
        ? 100
        : Math.min(integer(ext.limit, 'to-device limit'), 100),
      since: ext.since == null ? null : string(ext.since, 'to-device since'),
    };
  }
  for (const name of ['account_data', 'receipts', 'typing'] as const) {
    if (body[name] == null) continue;
    const ext = object(body[name], name);
    out[name] = {
      enabled: ext.enabled == null ? false : boolean(ext.enabled, 'enabled'),
      lists: ext.lists == null ? ['*'] : strings(ext.lists, 'extension lists'),
      rooms: ext.rooms == null ? ['*'] : strings(ext.rooms, 'extension rooms'),
    };
  }
  return out;
}

export function slidingSyncRequest(
  raw: unknown,
  query: URLSearchParams,
  maxTimeoutMs: number,
): SlidingRequest {
  const body = object(raw, 'body');
  const connId = body.conn_id == null ? '' : string(body.conn_id, 'conn_id');
  if (connId.length > 64) invalid('conn_id');
  const listEntries = Object.entries(object(body.lists ?? {}, 'lists'));
  const roomEntries = Object.entries(
    object(body.room_subscriptions ?? {}, 'room_subscriptions'),
  );
  if (listEntries.length > 100 || roomEntries.length > 100) {
    invalid('list/subscription count');
  }
  const pos = query.get('pos');
  if (pos === '') invalid('pos');
  const timeout = query.get('timeout');
  if (timeout !== null && !/^\d+$/.test(timeout)) invalid('timeout');
  const timeoutMs = timeout === null
    ? 0
    : Math.min(integer(Number(timeout), 'timeout'), maxTimeoutMs);
  const setPresence = query.get('set_presence') ?? undefined;
  if (
    setPresence !== undefined &&
    !['online', 'offline', 'unavailable'].includes(setPresence)
  ) invalid('set_presence');
  return {
    connId,
    pos,
    timeoutMs,
    setPresence,
    lists: Object.fromEntries(listEntries.map(([name, value]) => {
      if (name.length > 64) invalid('list key');
      return [name, listConfig(value)];
    })),
    subscriptions: Object.fromEntries(
      roomEntries.map(([name, value]) => [name, roomConfig(value)]),
    ),
    extensions: extensions(body.extensions),
  };
}
