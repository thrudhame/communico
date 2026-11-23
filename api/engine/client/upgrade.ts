import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  creationCreators,
  creationVersion,
} from '#engine/room/creation-input.ts';
import { moveAliases, roomAliases } from '#engine/server/aliases.ts';
import { initializePreparedRoom, prepareRoom } from '#engine/room/create.ts';
import { projectAfterWrite } from '#engine/room/hooks.ts';
import { localpartOf } from '#engine/ids.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { getProfile } from '#engine/tenant/users.ts';
import { visibility } from '#engine/server/directory.ts';
import {
  advanceRoomUpgrade,
  retainRoomUpgrade,
  roomUpgrade,
  withRoomUpgrade,
} from '#engine/server/room-upgrades.ts';
import { requireRoomForAdmission, stateAtSeq } from './room.ts';
import { powerFor } from './directory.ts';
import { writeStateKey } from './write.ts';
import { reconcileRoomRules } from './rule-migration.ts';
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
  requestedVersion: unknown,
  requestedCreators?: unknown,
) {
  const { version: newVersion, spec } = creationVersion(
    requestedVersion,
    'new_version',
  );
  const additionalCreators = creationCreators(spec, requestedCreators);
  const app = theApp();
  return await withRoomUpgrade(app.server, oldRoomId, userId, async () => {
    const room = await requireRoomForAdmission(oldRoomId);
    let retained = await roomUpgrade(app.server, oldRoomId);
    if (retained && retained.user !== userId) {
      throw new MatrixError(
        400,
        'M_BAD_STATE',
        'An upgrade for this room is already retained',
      );
    }
    // Authentication still precedes dispatch. A completed operation is this
    // user's durable result, not a new power-sensitive authoring attempt.
    if (retained?.phase === 4) {
      return { replacement_room: retained.replacement };
    }
    const power = await powerFor(oldRoomId, userId, 'm.room.tombstone');
    if (power.level < power.need) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'You cannot upgrade this room');
    }
    const state = await stateAtSeq(oldRoomId, null, undefined, 'admission'),
      oldCreate = state.find((r) =>
        r.type === 'm.room.create' && r.stateKey === ''
      )
        ?.content ?? {},
      oldPl =
        state.find((r) => r.type === 'm.room.power_levels' && r.stateKey === '')
          ?.content ?? {};
    await app.replica?.requireScope('directory');
    const aliases = await roomAliases(app.server, oldRoomId);
    const canon = state.find((row) =>
      row.type === 'm.room.canonical_alias' && row.stateKey === ''
    )?.content;
    if (
      app.replica && (aliases.length > 0 || typeof canon?.alias === 'string' ||
        (Array.isArray(canon?.alt_aliases) && canon.alt_aliases.length > 0) ||
        await visibility(app.server, oldRoomId) === 'public' ||
        retained?.plan.canonical)
    ) {
      throw new MatrixError(
        503,
        'M_UNAVAILABLE',
        'operation requires home ingress',
      );
    }
    const tombstone = state.find((row) =>
      row.type === 'm.room.tombstone' && row.stateKey === ''
    )?.content.replacement_room;
    if (
      retained && typeof tombstone === 'string' &&
      tombstone !== retained.replacement
    ) {
      throw new MatrixError(
        503,
        'M_UNAVAILABLE',
        'retained upgrade differs from the published tombstone',
      );
    }
    if (!retained) {
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
        const level = typeof pl.state_default === 'number'
          ? pl.state_default
          : 50;
        if ((events['m.room.tombstone'] ?? 0) < level + 1) {
          events['m.room.tombstone'] = 150;
        }
        pl.events = events;
      }
      const prepared = typeof tombstone === 'string'
        ? null
        : await prepareRoom(app.store, {
          creator: userId,
          version: newVersion,
          creation_content: creation,
          power_level_content_override: pl,
          creatorProfile: await getProfile(app.tenant, localpartOf(userId)) ??
            {},
          initial_state: state.filter((r) =>
            TRANSFER.includes(r.type) && r.type !== 'm.room.power_levels' &&
            r.stateKey === ''
          ).map((r) => ({
            type: r.type,
            state_key: r.stateKey,
            content: r.content,
          })),
        }, app.tenant.signer());
      retained = await retainRoomUpgrade(app.server, {
        oldRoom: oldRoomId,
        user: userId,
        replacement: prepared?.roomId ?? String(tombstone),
        plan: {
          prepared,
          oldPower: oldPl,
          canonical: aliases.length > 0 ? canon ?? null : null,
        },
        phase: 0,
      });
    }
    const result = { replacement_room: retained.replacement };
    const writeOnce = async (
      roomId: string,
      type: string,
      content: Record<string, unknown>,
    ) => {
      const current =
        (await stateAtSeq(roomId, null, [[type, '']], 'admission'))[0]
          ?.content;
      if (
        current === undefined ||
        canonicalJson(current) !== canonicalJson(content)
      ) {
        await writeStateKey(roomId, userId, type, '', content);
      } else {
        await projectAfterWrite(app.store, roomId);
      }
    };
    if (retained.phase === 0) {
      if (retained.plan.prepared) {
        await initializePreparedRoom(
          app.store,
          retained.plan.prepared,
          app.tenant.signer(),
        );
      } else {
        // A prior shared-handler upgrade already published its tombstone. Never
        // create another replacement just because it predates the local journal.
        try {
          await requireRoomForAdmission(retained.replacement);
        } catch (error) {
          if (error instanceof MatrixError && error.status === 404) {
            throw new MatrixError(
              503,
              'M_UNAVAILABLE',
              'existing replacement is unavailable',
            );
          }
          throw error;
        }
        await projectAfterWrite(app.store, retained.replacement);
      }
      // Projection callbacks are best-effort notices. Reconcile the existing
      // watermark owner before publishing aliases or the old-room tombstone.
      await reconcileRoomRules(app.store, app.tenant, retained.replacement);
      await advanceRoomUpgrade(app.server, retained, 1);
    }
    if (retained.phase === 1) {
      if (!app.replica) {
        await moveAliases(app.server, oldRoomId, retained.replacement);
        if (retained.plan.canonical) {
          await writeOnce(
            retained.replacement,
            'm.room.canonical_alias',
            retained.plan.canonical,
          );
        }
      }
      await advanceRoomUpgrade(app.server, retained, 2);
    }
    if (retained.phase === 2) {
      const existing = (await stateAtSeq(
        oldRoomId,
        null,
        [['m.room.tombstone', '']],
        'admission',
      ))[0]
        ?.content.replacement_room;
      if (typeof existing === 'string') {
        if (existing !== retained.replacement) {
          throw new MatrixError(
            503,
            'M_UNAVAILABLE',
            'retained upgrade differs from the published tombstone',
          );
        }
        // The existing PDU is the authority, including its original body and
        // event ID. Reconcile effects without authoring another tombstone.
        await projectAfterWrite(app.store, oldRoomId);
      } else {
        await writeOnce(oldRoomId, 'm.room.tombstone', {
          body: 'This room has been replaced',
          replacement_room: retained.replacement,
        });
      }
      await advanceRoomUpgrade(app.server, retained, 3);
    }
    if (retained.phase === 3) {
      const oldPl = retained.plan.oldPower;
      try {
        const level = typeof oldPl.users_default === 'number'
          ? oldPl.users_default
          : 0;
        await writeOnce(oldRoomId, 'm.room.power_levels', {
          ...oldPl,
          events_default: Math.max(50, level + 1),
          invite: Math.max(50, level + 1),
        });
      } catch (e) {
        // Synapse treats only authorization refusal as optional lockdown.
        // Storage/projection faults retain this phase for a truthful retry.
        if (!(e instanceof MatrixError && e.status === 403)) throw e;
        console.error('upgrade: old-room lockdown rejected (kept):', String(e));
      }
      await advanceRoomUpgrade(app.server, retained, 4);
    }
    return result;
  });
}
