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
  requireRetainedRequest,
  retainRoomUpgrade,
  roomUpgrade,
  type UpgradeRequest,
  withRoomUpgrade,
} from '#engine/server/room-upgrades.ts';
import { requireRoomForAdmission, stateAtSeq } from './room.ts';
import {
  parsePowerLevels,
  requiredLevel,
  userPowerLevel,
} from '#engine/rulebook/power-levels.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import type { Room } from '#engine/room/index.ts';
import type { Pdu } from '#engine/pdu.ts';
import { updateStateKey } from './write.ts';
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
  const request: UpgradeRequest = {
    version: newVersion,
    creators: spec.additionalCreators ? additionalCreators : [],
  };
  const app = theApp();
  return await withRoomUpgrade(
    app.server,
    oldRoomId,
    userId,
    request,
    async () => {
      const room = await requireRoomForAdmission(oldRoomId);
      const existing = await roomUpgrade(app.server, oldRoomId);
      if (existing) requireRetainedRequest(existing, userId, request);
      // Authentication still precedes dispatch. A completed operation is this
      // user's durable result, not a new power-sensitive authoring attempt.
      if (existing?.phase === 4) {
        return { replacement_room: existing.replacement };
      }
      // Resolve replica scopes outside the room mutation lock. Only the locked
      // snapshot below admits a plan; these reads just prepare legacy access.
      await app.replica?.requireScope('directory');
      const discovered = (await stateAtSeq(
        oldRoomId,
        null,
        [['m.room.tombstone', '']],
        'admission',
      ))[0]?.content.replacement_room;
      const legacy = typeof discovered === 'string'
        ? await stateAtSeq(
          discovered,
          null,
          [['m.room.create', '']],
          'admission',
        )
        : null;
      const retained = await withRoomLock(oldRoomId, async () => {
        let retained = existing;
        const state = await upgradeState(room);
        const oldCreateRow = state.find((r) =>
          r.type === 'm.room.create' && r.stateKey === ''
        );
        const oldPowerRow = state.find((r) =>
          r.type === 'm.room.power_levels' && r.stateKey === ''
        );
        const oldCreate = oldCreateRow?.content ?? {},
          oldPl = oldPowerRow?.content ?? {};
        const oldSpec = getRulebook(String(oldCreate.room_version ?? '1')).spec;
        const parsed = oldPowerRow ? parsePowerLevels(oldPl, oldSpec) : null;
        // Membership, power and retained identity share one room mutation cut.
        if (
          state.find((r) => r.type === 'm.room.member' && r.stateKey === userId)
            ?.content.membership !== 'join'
        ) {
          throw new MatrixError(
            403,
            'M_FORBIDDEN',
            'not joined to ' + oldRoomId,
          );
        }
        if (
          userPowerLevel(
            userId,
            oldPowerRow?.pdu ?? null,
            oldCreateRow?.pdu ?? null,
            oldSpec,
          ) <
            requiredLevel('m.room.tombstone', '', parsed?.ok ? parsed.pl : null)
        ) {
          throw new MatrixError(
            403,
            'M_FORBIDDEN',
            'You cannot upgrade this room',
          );
        }
        const aliases = await roomAliases(app.server, oldRoomId);
        const canon = state.find((row) =>
          row.type === 'm.room.canonical_alias' && row.stateKey === ''
        )?.content;
        if (
          app.replica &&
          (aliases.length > 0 || typeof canon?.alias === 'string' ||
            (Array.isArray(canon?.alt_aliases) &&
              canon.alt_aliases.length > 0) ||
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
          if (typeof tombstone === 'string') {
            if (tombstone !== discovered || legacy === null) {
              throw new MatrixError(
                503,
                'M_UNAVAILABLE',
                'legacy replacement changed during admission',
              );
            }
            const create = legacy[0]?.content;
            const creators = Array.isArray(create?.additional_creators)
              ? create.additional_creators
              : [];
            if (
              create?.room_version !== newVersion ||
              canonicalJson([...creators].sort()) !==
                canonicalJson([...request.creators].sort())
            ) {
              throw new MatrixError(
                400,
                'M_BAD_STATE',
                'existing replacement differs from requested upgrade',
              );
            }
          }
          const creation: Record<string, unknown> = {},
            predecessor: Record<string, unknown> = { room_id: oldRoomId };
          if (typeof oldCreate.type === 'string') {
            creation.type = oldCreate.type;
          }
          if (!spec.roomIdFromCreateEvent) {
            const tips = await room.tx(async (tx) => {
              const stay = await tx.segments.latestStay();
              return stay === null
                ? []
                : await tx.extremities.frontier(stay.id);
            });
            if (tips.length > 0) predecessor.event_id = tips[0];
          }
          creation.predecessor = predecessor;
          if (spec.additionalCreators && additionalCreators.length > 0) {
            creation.additional_creators = additionalCreators;
          }
          const pl = JSON.parse(JSON.stringify(oldPl)) as Record<
            string,
            unknown
          >;
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
              creatorProfile:
                await getProfile(app.tenant, localpartOf(userId)) ??
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
              request,
              canonical: aliases.length > 0 ? canon ?? null : null,
            },
            phase: 0,
          });
        }
        return retained;
      });
      const result = { replacement_room: retained.replacement };
      const writeOnce = async (
        roomId: string,
        type: string,
        content: Record<string, unknown>,
      ) => {
        await updateStateKey(
          roomId,
          userId,
          type,
          '',
          (current) =>
            current !== undefined &&
              canonicalJson(current) === canonicalJson(content)
              ? null
              : content,
        );
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
        // Phase 2 establishes the room authority before directory effects.
        await advanceRoomUpgrade(app.server, retained, 2);
      }
      if (retained.phase === 2) {
        await updateStateKey(
          oldRoomId,
          userId,
          'm.room.tombstone',
          '',
          (current) => {
            const existing = current?.replacement_room;
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
              return null;
            } else {
              return {
                body: 'This room has been replaced',
                replacement_room: retained.replacement,
              };
            }
          },
        );
        await withRoomLock(oldRoomId, async () => {
          const current = (await upgradeState(room)).find((r) =>
            r.type === 'm.room.tombstone' && r.stateKey === ''
          )?.content.replacement_room;
          if (current !== retained.replacement) {
            throw new MatrixError(
              503,
              'M_UNAVAILABLE',
              'published tombstone changed before alias transfer',
            );
          }
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
        });
        await advanceRoomUpgrade(app.server, retained, 3);
      }
      if (retained.phase === 3) {
        try {
          // Synapse's lockdown: from the CURRENT power levels, raise only
          // invite/events_default below max(users_default + 1, 50). A retry
          // never restores power the room changed after the upgrade began.
          await updateStateKey(
            oldRoomId,
            userId,
            'm.room.power_levels',
            '',
            (current, spec) => {
              const parsed = current === undefined ? null : parsePowerLevels(
                current,
                spec,
              );
              if (current !== undefined && parsed?.ok) {
                const pl = parsed.pl;
                const restricted = Math.max((pl.users_default ?? 0) + 1, 50);
                const locked = { ...current };
                for (const key of ['invite', 'events_default'] as const) {
                  if ((pl[key] ?? 0) < restricted) locked[key] = restricted;
                }
                return canonicalJson(current) === canonicalJson(locked)
                  ? null
                  : locked;
              }
              return null;
            },
          );
        } catch (e) {
          // Synapse treats only authorization refusal as optional lockdown.
          // Storage/projection faults retain this phase for a truthful retry.
          if (!(e instanceof MatrixError && e.status === 403)) throw e;
          console.error(
            'upgrade: old-room lockdown rejected (kept):',
            String(e),
          );
        }
        await advanceRoomUpgrade(app.server, retained, 4);
      }
      return result;
    },
  );
}

async function upgradeState(room: Room) {
  return await room.tx(async (tx) => {
    const stay = await tx.segments.latestStay();
    const group = stay === null ? null : await tx.state.current(stay.id);
    const state: {
      type: string;
      stateKey: string;
      content: Record<string, unknown>;
      pdu: Pdu;
    }[] = [];
    if (group === null) return state;
    for (const entry of await tx.state.groupEntries(group)) {
      const event = entry.event === null
        ? null
        : await tx.events.get(entry.event);
      if (!event) continue;
      const pdu = JSON.parse(event.pdu) as Pdu;
      state.push({
        type: entry.type,
        stateKey: entry.state_key,
        content: pdu.content ?? {},
        pdu,
      });
    }
    return state;
  });
}
