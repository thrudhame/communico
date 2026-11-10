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
import { loadRulebookStore, roomVersionOf } from './build.ts';
import { openRoom, type Room, type RoomTx } from './index.ts';
import { withRoomLock } from './lock.ts';

async function current(tx: RoomTx) {
  const stay = await tx.segments.openStay();
  const group = stay === null ? null : await tx.state.current(stay.id);
  return { stay, group };
}

async function target(tx: RoomTx, user: string) {
  const { stay, group } = await current(tx);
  if (stay === null || group === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'not resident');
  }
  const version = await roomVersionOf(tx, stay.id);
  const rulebook = getRulebook(version);
  const state = await tx.state.groupMap(group);
  const store = await loadRulebookStore(tx, [...state.values()]);
  const content = (type: string, key = '') =>
    store.get(state.get(type + '\0' + key) ?? '')?.content;
  const previous = content('m.room.member', user)?.membership;
  if (previous === 'ban') {
    throw new MatrixError(403, 'M_FORBIDDEN', 'user is banned');
  }
  const rules = content('m.room.join_rules');
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
  return {
    group,
    stay: stay.id,
    required,
    rooms: [...new Set(rooms)],
    unknown,
    authorizers: inviteCapableUsers(state, store, rulebook.spec),
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
  before?: () => Promise<void>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const captured = await room.tx((tx) => target(tx, user));
    let proof: Witness | null = null;
    let unknown = captured.unknown;
    if (captured.required) {
      for (const id of captured.rooms) {
        let allowed;
        try {
          allowed = await openRoom(room.store, id);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
          if (domainOf(user) !== self) unknown = true;
          continue;
        }
        proof = await witness(allowed, user);
        if (proof !== null) break;
        if (
          domainOf(user) !== self &&
          await allowed.tx((tx) => tx.segments.openStay()) === null
        ) unknown = true;
      }
    }
    const result = await withRoomLock(room.id, async () => {
      await before?.();
      if (proof !== null) {
        const now = await witness(proof.room, user);
        if (
          now === null || now.stay !== proof.stay || now.group !== proof.group
        ) return changed;
      }
      return await room.tx(async (tx) => {
        const now = await target(tx, user);
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
          const candidates = now.authorizers.filter((u) =>
            domainOf(u) === self
          );
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
  const snapshot = await room.tx((tx) => target(tx, user));
  return [...new Set(snapshot.authorizers.map(domainOf))];
}
