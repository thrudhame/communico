// Published room metadata has one serializer for directory, summary and spaces.
// Admission belongs to each discovery operation, not to this representation.
import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import { joinedUsers } from '#engine/server/directory.ts';
import { renderStateEvent } from './render.ts';
import { requireRoom } from './room.ts';
import { admitState } from './state-admission.ts';

const SUMMARY_TYPES = [
  'm.room.create',
  'm.room.name',
  'm.room.topic',
  'm.room.canonical_alias',
  'm.room.history_visibility',
  'm.room.guest_access',
  'm.room.join_rules',
  'm.room.avatar',
  'm.room.encryption',
];
export async function heldRoomSummary(roomId: string) {
  const room = await requireRoom(roomId);
  const content = new Map<string, Record<string, unknown>>();
  const admission = await admitState(room, { userId: null, discovery: true });
  for (const row of admission.rows) {
    if (row.stateKey !== '' || !SUMMARY_TYPES.includes(row.type)) continue;
    const event = await renderStateEvent(room, row.eventId, undefined, {
      bundleThreads: false,
      admission,
    });
    if (event !== null) {
      content.set(row.type, event.content as Record<string, unknown>);
    }
  }
  const value = (type: string, key: string) => {
    const v = content.get(type)?.[key];
    return typeof v === 'string' ? v : undefined;
  };
  const summary: Record<string, unknown> = {
    room_id: roomId,
    num_joined_members: (await joinedUsers(theApp().server, roomId)).length,
    world_readable: value('m.room.history_visibility', 'history_visibility') ===
      'world_readable',
    guest_can_join: value('m.room.guest_access', 'guest_access') === 'can_join',
    join_rule: value('m.room.join_rules', 'join_rule') ?? 'invite',
    room_version: value('m.room.create', 'room_version') ?? '1',
  };
  for (
    const [key, type, field] of [
      ['name', 'm.room.name', 'name'],
      ['topic', 'm.room.topic', 'topic'],
      ['canonical_alias', 'm.room.canonical_alias', 'alias'],
      ['avatar_url', 'm.room.avatar', 'url'],
      ['room_type', 'm.room.create', 'type'],
      ['encryption', 'm.room.encryption', 'algorithm'],
    ]
  ) {
    const v = value(type!, field!);
    if (v !== undefined) summary[key!] = v;
  }
  const allow = content.get('m.room.join_rules')?.allow;
  const spec = getRulebook(String(summary.room_version)).spec;
  if (
    ((summary.join_rule === 'restricted' && spec.restrictedJoinRule) ||
      (summary.join_rule === 'knock_restricted' &&
        spec.knockRestrictedJoinRule)) && Array.isArray(allow)
  ) {
    summary.allowed_room_ids = allow.filter((entry) =>
      entry !== null && typeof entry === 'object' &&
      entry.type === 'm.room_membership' && typeof entry.room_id === 'string'
    ).map((entry) => entry.room_id);
  }
  return summary;
}

export async function publicRoomSummary(roomId: string) {
  const summary = await heldRoomSummary(roomId);
  return Object.fromEntries(
    Object.entries(summary).filter(([key]) =>
      !['encryption', 'room_version', 'allowed_room_ids'].includes(key)
    ),
  );
}

export function roomTypesFilter(value: unknown): (string | null)[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((type) => type !== null && typeof type !== 'string')
  ) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'room_types must contain strings or null',
    );
  }
  return value;
}
