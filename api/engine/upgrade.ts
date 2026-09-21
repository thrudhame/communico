// api/engine/upgrade.ts — POST /rooms/{id}/upgrade (plan D7, spec v1.16
// room_upgrades.yaml:19-112 + room_upgrades.md:27-83): permission check,
// replacement room with predecessor, transferable state, alias move,
// tombstone, old-room lockdown. Everything authors through
// authorAndIngest (the rulebook decides what it doesn't pre-check).
import { serverDb, withDb } from './db.ts';
import { serverName } from './config.ts';
import { MatrixError } from './matrix-error.ts';
import { createRoom, lookupRoom, stateAtSeq } from './room.ts';
import { roomAliases } from './aliases.ts';
import { authorAndIngest } from './ingest.ts';
import { eventIndexRow } from './room.ts';
import { getRulebook } from './policy.ts';
import {
  parsePowerLevels,
  requiredLevel,
  userPowerLevel,
} from './rulebook/power-levels.ts';
import { pduById } from './timeline.ts';

// The spec's recommended transferable state (room_upgrades.md:54-62).
const TRANSFER_TYPES = [
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

// 3e: the new users map. For a v12 target, drop the upgrader and every
// new creator (creators are implicit there) and floor m.room.tombstone
// at 150 when it would fall below state_default+1 (create_room.yaml
// :48-50); for a ≤11 target the PL is copied verbatim (createRoom's
// genesis default then keeps the upgrader at 100 when absent).
function transformPl(
  oldPl: Record<string, unknown>,
  upgrader: string,
  additionalCreators: string[],
  targetV12: boolean,
): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(oldPl)) as Record<string, unknown>;
  if (!targetV12) return out;
  const users = { ...((out.users ?? {}) as Record<string, number>) };
  delete users[upgrader];
  for (const c of additionalCreators) delete users[c];
  out.users = users;
  const events = { ...((out.events ?? {}) as Record<string, number>) };
  const stateDefault = typeof out.state_default === 'number'
    ? out.state_default
    : 50;
  if ((events['m.room.tombstone'] ?? 0) < stateDefault + 1) {
    events['m.room.tombstone'] = 150;
  }
  out.events = events;
  return out;
}

export async function upgradeRoom(
  oldRoomId: string,
  userId: string,
  newVersion: string,
  additionalCreators: string[] = [],
): Promise<{ replacement_room: string }> {
  const room = await lookupRoom(oldRoomId);
  if (!room) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + oldRoomId);
  }
  // unknown version → 400 M_UNSUPPORTED_ROOM_VERSION (room_upgrades.yaml
  // :77-90); never a silent default
  let targetSpec;
  try {
    targetSpec = getRulebook(newVersion).spec;
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

  // (1) the upgrader must be allowed to send m.room.tombstone in the old
  // room (room_upgrades.md:30-31) — creators pass by construction.
  const state = (await stateAtSeq(oldRoomId, null)) ?? [];
  const plRow = state.find((r) => r.type === 'm.room.power_levels');
  const createRow = state.find((r) => r.type === 'm.room.create');
  const plPdu = plRow
    ? await pduById(
      room.dbName,
      (await eventIndexRow(oldRoomId, plRow.eventId))!.commit_hash,
      plRow.eventId,
    )
    : null;
  const createPdu = createRow
    ? await pduById(
      room.dbName,
      (await eventIndexRow(oldRoomId, createRow.eventId))!.commit_hash,
      createRow.eventId,
    )
    : null;
  const parsed = plPdu
    ? parsePowerLevels(plPdu.content, getRulebook(room.roomVersion).spec)
    : null;
  const pl = parsed?.ok ? parsed.pl : null;
  const level = userPowerLevel(
    userId,
    plPdu,
    createPdu,
    getRulebook(room.roomVersion).spec,
  );
  const need = requiredLevel('m.room.tombstone', '', pl);
  if (level < need) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'You cannot upgrade this room',
    );
  }

  // (2) the replacement room (room_upgrades.md:33-48): predecessor (+ no
  // event_id for v12, 3f), type copied, additional_creators only when
  // supported and non-empty (key absent otherwise).
  const oldCreateContent = (createPdu?.content ?? {}) as Record<
    string,
    unknown
  >;
  const creationContent: Record<string, unknown> = {};
  if (typeof oldCreateContent.type === 'string') {
    creationContent.type = oldCreateContent.type;
  }
  const predecessor: Record<string, unknown> = { room_id: oldRoomId };
  if (!targetSpec.roomIdFromCreateEvent) {
    // 3f: predecessor.event_id stays populated for ≤11 targets — the old
    // room's head extremity at upgrade time
    const { extremities } = await import('./room.ts');
    const tips = await extremities(room.dbName, oldRoomId);
    if (tips.length > 0) predecessor.event_id = tips[0].eventId;
  }
  creationContent.predecessor = predecessor;
  if (
    targetSpec.additionalCreators && additionalCreators.length > 0
  ) {
    creationContent.additional_creators = additionalCreators;
  }

  // (3) transferable state (room_upgrades.md:50-62). The PL content is
  // transformed per 3e before createRoom's override validation sees it.
  const transfer = state.filter((r) =>
    TRANSFER_TYPES.includes(r.type) && r.stateKey === ''
  );
  const oldPl = (plRow?.content ?? {}) as Record<string, unknown>;
  const plContent = transformPl(
    oldPl,
    userId,
    additionalCreators,
    targetSpec.creatorsHaveInfinitePower,
  );
  const res = await createRoom(
    '!' + crypto.randomUUID() + ':' + serverName(),
    userId,
    {
      roomVersion: newVersion,
      creationContent,
      powerLevelContentOverride: plContent,
      initialState: transfer
        .filter((r) => r.type !== 'm.room.power_levels')
        .map((r) => ({
          type: r.type,
          state_key: r.stateKey,
          content: r.content,
        })),
      fromUpgrade: true,
    },
  );

  // (4) move local aliases and re-emit the canonical alias in the new
  // room (room_upgrades.md:71).
  const aliases = await roomAliases(oldRoomId);
  if (aliases.length > 0) {
    await withDb(serverDb(), async (c) => {
      await c.query(
        'UPDATE room_aliases SET room_id = $1 WHERE room_id = $2;',
        [res.roomId, oldRoomId],
      );
    });
    const oldCanon = state.find(
      (r) => r.type === 'm.room.canonical_alias' && r.stateKey === '',
    );
    if (oldCanon) {
      await authorAndIngest(res.roomId, {
        type: 'm.room.canonical_alias',
        state_key: '',
        sender: userId,
        content: oldCanon.content,
        origin_server_ts: Date.now(),
      });
    }
  }

  // (5) the tombstone in the old room (room_upgrades.md:73-74;
  // m.room.tombstone.yaml requires body + replacement_room)
  await authorAndIngest(oldRoomId, {
    type: 'm.room.tombstone',
    state_key: '',
    sender: userId,
    content: {
      body: 'This room has been replaced',
      replacement_room: res.roomId,
    },
    origin_server_ts: Date.now(),
  });

  // (6) old-room lockdown: events_default and invite to
  // max(50, users_default+1) (room_upgrades.md:76-79), best-effort — a
  // rulebook reject here (e.g. the upgrader lacks the level in a v12 old
  // room) is logged, never fatal.
  try {
    const oldUsersDefault = typeof oldPl.users_default === 'number'
      ? oldPl.users_default
      : 0;
    const lockdown = {
      ...oldPl,
      events_default: Math.max(50, oldUsersDefault + 1),
      invite: Math.max(50, oldUsersDefault + 1),
    };
    await authorAndIngest(oldRoomId, {
      type: 'm.room.power_levels',
      state_key: '',
      sender: userId,
      content: lockdown,
      origin_server_ts: Date.now(),
    });
  } catch (e) {
    console.error('upgrade: old-room lockdown rejected (kept):', String(e));
  }

  return { replacement_room: res.roomId };
}
