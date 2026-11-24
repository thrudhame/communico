// Published room metadata has one serializer for directory, summary and spaces.
// Admission belongs to each discovery operation, not to this representation.
import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import { openRoom, type Room } from '#engine/room/index.ts';
import { joinedUsers } from '#engine/server/directory.ts';
import { renderStateEvents } from './render.ts';
import {
  requireRoom,
  requireRoomForAdmission,
  type RoomAccess,
} from './room.ts';
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
export async function heldRoomSummary(
  roomId: string,
  access: RoomAccess = 'read',
) {
  const room = access === 'read'
    ? await requireRoom(roomId)
    : await requireRoomForAdmission(roomId);
  return await heldRoomSummaryAt(room);
}

async function heldRoomSummaryAt(room: Room, joined?: number) {
  const roomId = room.id;
  const content = new Map<string, Record<string, unknown>>();
  const admission = await admitState(room, { userId: null, discovery: true });
  const rows = admission.rows.filter((row) =>
    row.stateKey === '' && SUMMARY_TYPES.includes(row.type)
  );
  const rendered = await renderStateEvents(
    room,
    rows.map((row) => row.eventId),
    undefined,
    {
      bundleThreads: false,
      admission,
    },
  );
  for (const row of rows) {
    const event = rendered.get(row.eventId);
    if (event !== undefined) {
      content.set(row.type, event.content as Record<string, unknown>);
    }
  }
  const value = (type: string, key: string) => {
    const v = content.get(type)?.[key];
    return typeof v === 'string' ? v : undefined;
  };
  const summary: Record<string, unknown> = {
    room_id: roomId,
    num_joined_members: joined ??
      (await joinedUsers(theApp().server, roomId)).length,
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

export async function publicRoomSummary(
  roomId: string,
  access: RoomAccess = 'read',
) {
  return publicFields(await heldRoomSummary(roomId, access));
}

// Called only for rows selected and scope-checked by the ranked page owner.
export async function rankedPublicRoomSummary(roomId: string, joined: number) {
  try {
    const room = await openRoom(theApp().store, roomId);
    return publicFields(await heldRoomSummaryAt(room, joined));
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
}

function publicFields(summary: Record<string, unknown>) {
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
