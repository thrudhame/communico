import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import { moveAliases, roomAliases } from '#engine/server/aliases.ts';
import { migrateRoomRules } from '#engine/tenant/pushrules.ts';
import { requireRoom, stateAtSeq } from './room.ts';
import { powerFor } from './directory.ts';
import { createRoom, writeStateKey } from './write.ts';
const TRANSFER = [
  'm.room.server_acl',
  'm.room.encryption',
  'm.room.name',
  'm.room.avatar',
  'm.room.topic',
  'm.room.guest_access',
  'm.room.history_visibility',
  'm.room.join_rules',
  'm.room.power_levels',
];
export async function upgradeRoom(
  oldRoomId: string,
  userId: string,
  newVersion: string,
  additionalCreators: string[] = [],
) {
  const room = await requireRoom(oldRoomId);
  let spec;
  try {
    spec = getRulebook(newVersion).spec;
  } catch (e) {
    if (String(e).includes('M_UNSUPPORTED_ROOM_VERSION')) {
      throw new MatrixError(
        400,
        'M_UNSUPPORTED_ROOM_VERSION',
        'This server does not support that room version',
      );
    }
    throw e;
  }
  const power = await powerFor(oldRoomId, userId, 'm.room.tombstone');
  if (power.level < power.need) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'You cannot upgrade this room');
  }
  const state = await stateAtSeq(oldRoomId, null),
    oldCreate =
      state.find((r) => r.type === 'm.room.create' && r.stateKey === '')
        ?.content ?? {},
    oldPl =
      state.find((r) => r.type === 'm.room.power_levels' && r.stateKey === '')
        ?.content ?? {};
  const creation: Record<string, unknown> = {},
    predecessor: Record<string, unknown> = { room_id: oldRoomId };
  if (typeof oldCreate.type === 'string') creation.type = oldCreate.type;
  if (!spec.roomIdFromCreateEvent) {
    const tips = await room.tx(async (tx) => {
      const stay = await tx.segments.latestStay();
      return stay === null ? [] : await tx.extremities.frontier(stay.id);
    });
    if (tips.length > 0) predecessor.event_id = tips[0];
  }
  creation.predecessor = predecessor;
  if (spec.additionalCreators && additionalCreators.length > 0) {
    creation.additional_creators = additionalCreators;
  }
  const pl = JSON.parse(JSON.stringify(oldPl)) as Record<string, unknown>;
  if (spec.creatorsHaveInfinitePower) {
    const users = { ...(pl.users as Record<string, unknown> ?? {}) };
    delete users[userId];
    for (const c of additionalCreators) delete users[c];
    pl.users = users;
    const events = { ...(pl.events as Record<string, number> ?? {}) };
    const level = typeof pl.state_default === 'number' ? pl.state_default : 50;
    if ((events['m.room.tombstone'] ?? 0) < level + 1) {
      events['m.room.tombstone'] = 150;
    }
    pl.events = events;
  }
  const result = await createRoom({
    creator: userId,
    version: newVersion,
    creation_content: creation,
    power_level_content_override: pl,
    initial_state: state.filter((r) =>
      TRANSFER.includes(r.type) && r.type !== 'm.room.power_levels' &&
      r.stateKey === ''
    ).map((r) => ({ type: r.type, state_key: r.stateKey, content: r.content })),
  });
  await migrateRoomRules(theApp().tenant, oldRoomId, result.roomId);
  if ((await roomAliases(theApp().server, oldRoomId)).length > 0) {
    await moveAliases(theApp().server, oldRoomId, result.roomId);
    const canon = state.find((r) =>
      r.type === 'm.room.canonical_alias' && r.stateKey === ''
    );
    if (canon) {
      await writeStateKey(
        result.roomId,
        userId,
        'm.room.canonical_alias',
        '',
        canon.content,
      );
    }
  }
  await writeStateKey(oldRoomId, userId, 'm.room.tombstone', '', {
    body: 'This room has been replaced',
    replacement_room: result.roomId,
  });
  try {
    const level = typeof oldPl.users_default === 'number'
      ? oldPl.users_default
      : 0;
    await writeStateKey(oldRoomId, userId, 'm.room.power_levels', '', {
      ...oldPl,
      events_default: Math.max(50, level + 1),
      invite: Math.max(50, level + 1),
    });
  } catch (e) {
    console.error('upgrade: old-room lockdown rejected (kept):', String(e));
  }
  return { replacement_room: result.roomId };
}
