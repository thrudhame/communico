// Current cross-room eligibility belongs to the local decision to vouch,
// never DAG auth. Reads are captured outside the target write and their
// immutable (stay,group) revisions revalidated before its locked transaction.
// A qualifying read is the authorization linearization point: leaving the
// allowed room later does not retroactively invalidate an authorized join.
// No nested room transactions, network calls, or arbitrary multi-room locks.
import { domainOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import { inviteCapableUsers } from '#engine/rulebook/auth-rules.ts';
import {
  loadRulebookStore,
  resolvePrevs,
  roomVersionOf,
  stateBefore,
} from './build.ts';
import { openRoom, type Room, type RoomTx } from './index.ts';
import { withRoomLock } from './lock.ts';
import {
  type PreparedRestrictedKnowledge,
  prepareRestrictedKnowledge,
  restrictedKnowledge,
} from './hooks.ts';

async function current(tx: RoomTx) {
  const stay = await tx.segments.openStay();
  const group = stay === null ? null : await tx.state.current(stay.id);
  return { stay, group };
}

async function target(
  tx: RoomTx,
  user: string,
  needAuthorizers = false,
  allowAbsent = false,
) {
  const { stay, group } = await current(tx);
  if (stay === null || group === null) {
    if (allowAbsent) return null;
    throw new MatrixError(404, 'M_NOT_FOUND', 'not resident');
  }
  const version = await roomVersionOf(tx, stay.id);
  const rulebook = getRulebook(version);
  const content = async (type: string, key = '') => {
    const id = await tx.state.groupKey(group, type, key);
    const event = id === null ? null : await tx.events.get(id);
    return event === null ? undefined : JSON.parse(event.pdu).content;
  };
  const previous = (await content('m.room.member', user))?.membership;
  if (previous === 'ban') {
    throw new MatrixError(403, 'M_FORBIDDEN', 'user is banned');
  }
  const rules = await content('m.room.join_rules');
  const restricted =
    (rules?.join_rule === 'restricted' && rulebook.spec.restrictedJoinRule) ||
    (rules?.join_rule === 'knock_restricted' &&
      rulebook.spec.knockRestrictedJoinRule);
  const required = restricted && previous !== 'join' && previous !== 'invite';
  const rooms: string[] = [];
  let unknown = false;
  if (required && Array.isArray(rules?.allow)) {
    for (const entry of rules.allow) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      if (entry.type !== 'm.room_membership') {
        unknown = true;
        continue;
      }
      if (typeof entry.room_id === 'string' && entry.room_id.startsWith('!')) {
        rooms.push(entry.room_id);
      }
    }
  }
  let authorizers: string[] = [];
  if (required || needAuthorizers) {
    const state = await tx.state.groupMap(group);
    const store = await loadRulebookStore(tx, [...state.values()]);
    authorizers = inviteCapableUsers(state, store, rulebook.spec);
  }
  return {
    group,
    stay: stay.id,
    required,
    rooms: [...new Set(rooms)],
    unknown,
    authorizers,
  };
}

type Witness = { room: Room; stay: number; group: number };
/** Read-only discovery eligibility shares the authoritative allowed-room
 * membership witness, without vouching, creating a stay or authoring a join. */
export async function joinedAllowedRoom(
  store: Room['store'],
  user: string,
  roomIds: readonly string[],
): Promise<boolean> {
  for (const id of roomIds) {
    if (await restrictedKnowledge(store, id) === 'unavailable') continue;
    let room;
    try {
      room = await openRoom(store, id);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    if (await witness(room, user) !== null) return true;
  }
  return false;
}

async function witness(room: Room, user: string): Promise<Witness | null> {
  return await room.tx(async (tx) => {
    const { stay, group } = await current(tx);
    if (stay === null || group === null) return null;
    const id = await tx.state.groupKey(group, 'm.room.member', user);
    const row = id === null ? null : await tx.events.get(id);
    if (row === null || JSON.parse(row.pdu).content?.membership !== 'join') {
      return null;
    }
    return { room, stay: stay.id, group };
  });
}

const changed = Symbol('restricted snapshot changed');
export async function withRestrictedAdmission<T>(
  room: Room,
  user: string,
  self: string,
  operation: (tx: RoomTx, authorizer: string | null) => T | Promise<T>,
  nominated?: string,
  before?: (resident: boolean) => Promise<void>,
  absent?: (tx: RoomTx) => T | Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const captured = await room.tx((tx) =>
      target(tx, user, nominated !== undefined, absent !== undefined)
    );
    let proof: Witness | null = null;
    let unknown = captured?.unknown ?? false;
    if (captured?.required) {
      for (const id of captured.rooms) {
        const knowledge = await restrictedKnowledge(room.store, id);
        if (knowledge === 'unavailable') {
          unknown = true;
          continue;
        }
        let allowed;
        try {
          allowed = await openRoom(room.store, id);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
          if (domainOf(user) !== self || knowledge === 'partial') {
            unknown = true;
          }
          continue;
        }
        proof = await witness(allowed, user);
        if (proof !== null) break;
        if (
          (domainOf(user) !== self || knowledge === 'partial') &&
          await allowed.tx(async (tx) => {
            const snapshot = await current(tx);
            return snapshot.stay === null || snapshot.group === null;
          })
        ) unknown = true;
      }
    }
    const result = await withRoomLock(room.id, async () => {
      let allowedScope: PreparedRestrictedKnowledge | undefined;
      if (before) {
        const { stay, group } = await room.tx(current);
        await before(stay !== null && group !== null);
      }
      if (proof !== null) {
        allowedScope = await prepareRestrictedKnowledge(
          room.store,
          proof.room.id,
        );
        if (allowedScope.knowledge === 'unavailable') return changed;
        const now = await witness(proof.room, user);
        if (
          now === null || now.stay !== proof.stay || now.group !== proof.group
        ) return changed;
      }
      return await room.tx(async (tx) => {
        const now = await target(
          tx,
          user,
          nominated !== undefined,
          absent !== undefined,
        );
        // Residency can change while cross-room evidence is captured. Only
        // this locked decision may select the archived path or publish a join.
        if (now === null) return await absent!(tx);
        if (captured === null) return changed;
        if (now.group !== captured.group || now.stay !== captured.stay) {
          return changed;
        }
        let authorizer: string | null = null;
        if (now.required) {
          if (proof === null) {
            throw new MatrixError(
              unknown ? 400 : 403,
              unknown ? 'M_UNABLE_TO_AUTHORISE_JOIN' : 'M_FORBIDDEN',
              'restricted join eligibility not established',
            );
          }
          // Scope/control retirement is not an ordinary later DAG departure.
          // Carry its prepared authority to the target's actual native commit,
          // without reading another authority file inside this transaction.
          if (allowedScope?.checkCurrent) tx.admit(allowedScope.checkCurrent);
          let candidates = now.authorizers.filter((u) => domainOf(u) === self);
          if (nominated === undefined) {
            // Both local joins and federation templates author from the selected
            // parents. Vouching still needs current eligibility, but a candidate
            // absent or underpowered in those parents cannot authorize that PDU.
            // Inbound nominees retain their actual-PDU DAG check in ingest.
            const rulebook = getRulebook(await roomVersionOf(tx, now.stay));
            const parents = await resolvePrevs(
              tx,
              await tx.extremities.parents(now.stay),
            );
            const state = await stateBefore(tx, parents.afterGroups, rulebook);
            const store = await loadRulebookStore(tx, [...state.values()]);
            const eligible = new Set(
              inviteCapableUsers(state, store, rulebook.spec),
            );
            candidates = candidates.filter((user) => eligible.has(user));
          }
          authorizer = nominated === undefined
            ? candidates[0] ?? null
            : candidates.includes(nominated)
            ? nominated
            : null;
          if (authorizer === null) {
            throw new MatrixError(
              400,
              'M_UNABLE_TO_GRANT_JOIN',
              'no local invite-capable authorizer',
            );
          }
        } else if (
          nominated !== undefined &&
          (!now.authorizers.includes(nominated) || domainOf(nominated) !== self)
        ) {
          throw new MatrixError(403, 'M_FORBIDDEN', 'invalid authorizer');
        }
        return await operation(tx, authorizer);
      });
    });
    if (result !== changed) return result;
  }
  throw new MatrixError(
    400,
    'M_UNABLE_TO_AUTHORISE_JOIN',
    'restricted state changed during authorization',
  );
}

export async function restrictedResidents(
  room: Room,
  user: string,
): Promise<string[]> {
  return await room.tx(async (tx) => {
    if (await tx.segments.openStay() === null) return [];
    const snapshot = await target(tx, user, true);
    return [...new Set(snapshot!.authorizers.map(domainOf))];
  });
}
