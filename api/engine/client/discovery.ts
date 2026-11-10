// Discovery access and remote orchestration, separate from room serialization.
import { theApp } from '#engine/app.ts';
import { config, serverName } from '#engine/config.ts';
import { domainOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getRulebook, supportedRoomVersions } from '#engine/rulebook/index.ts';
import { roomAllows } from '#engine/federation/acl.ts';
import { discoveryRequest } from '#engine/federation/discovery.ts';
import { joinedAllowedRoom } from '#engine/room/restricted.ts';
import { membershipOf } from '#engine/server/read.ts';
import { resolveAlias } from './directory.ts';
import { lookupRoom } from './room.ts';
import { heldRoomSummary } from './summary.ts';

type Json = Record<string, unknown>;
export type DiscoveryPrincipal = { user: string | null } | { origin: string };

export async function summaryAccessible(
  summary: Json,
  principal: DiscoveryPrincipal,
): Promise<boolean> {
  const app = theApp(), id = String(summary.room_id);
  // The shared room-summary wire schema defaults an omitted join_rule to
  // public. Standard servers (including tuwunel) use that omission.
  const joinRule = summary.join_rule === undefined
    ? 'public'
    : summary.join_rule;
  if (
    'origin' in principal && !await roomAllows(app.store, id, principal.origin)
  ) return false;
  const spec = typeof summary.room_version === 'string' &&
      supportedRoomVersions().includes(summary.room_version)
    ? getRulebook(summary.room_version).spec
    : null;
  if (
    summary.world_readable === true || joinRule === 'public' ||
    (joinRule === 'knock' && (spec === null || spec.knockJoinRule)) ||
    (joinRule === 'knock_restricted' &&
      (spec === null || spec.knockRestrictedJoinRule))
  ) return true;
  const users: string[] = [];
  if ('user' in principal) {
    if (principal.user === null) return false;
    const membership = await membershipOf(app.server, id, principal.user);
    if (
      membership?.membership === 'join' || membership?.membership === 'invite'
    ) return true;
    users.push(principal.user);
  } else {
    const members = await app.server.query(
      "SELECT user FROM memberships WHERE room=? AND membership IN ('join','invite')",
      [id],
    );
    if (
      members.some((row) => domainOf(String(row.user)) === principal.origin)
    ) return true;
    const joined = await app.server.query(
      "SELECT DISTINCT user FROM memberships WHERE membership='join'",
    );
    users.push(
      ...joined.map((row) => String(row.user)).filter((user) =>
        domainOf(user) === principal.origin
      ),
    );
  }
  if (
    (joinRule === 'restricted' ||
      joinRule === 'knock_restricted') &&
    Array.isArray(summary.allowed_room_ids)
  ) {
    const allowed = summary.allowed_room_ids.filter((id): id is string =>
      typeof id === 'string'
    );
    for (const user of users) {
      if (await joinedAllowedRoom(app.store, user, allowed)) return true;
    }
  }
  return false;
}

export async function localDiscoverySummary(
  id: string,
  principal: DiscoveryPrincipal,
): Promise<Json | null> {
  if (await lookupRoom(id) === null) return null;
  const summary = await heldRoomSummary(id);
  return await summaryAccessible(summary, principal) ? summary : null;
}

/** Unheld-room summaries travel via the actual federation hierarchy API, never
 * a fabricated federation room_summary endpoint or participation intent. */
export async function remoteDiscoveryHierarchy(
  id: string,
  user: string,
  via: readonly string[],
  suggested = false,
): Promise<{ room: Json; inaccessible: string[] } | null> {
  if (!config().federation.enabled) return null;
  const app = theApp();
  let failure: unknown;
  for (
    const destination of [...new Set(via)].filter((name) =>
      name !== serverName()
    ).slice(0, config().federation.discoveryservers)
  ) {
    let response: unknown;
    try {
      response = await discoveryRequest(app.server, app.tenant.signer(), {
        destination,
        room: { store: app.store, id },
        path: '/_matrix/federation/v1/hierarchy/' + encodeURIComponent(id) +
          (suggested ? '?suggested_only=true' : ''),
      });
    } catch (error) {
      if (!(error instanceof MatrixError)) throw error;
      failure = error;
      continue;
    }
    const root = response !== null && typeof response === 'object' &&
        !Array.isArray(response)
      ? (response as Json).room
      : undefined;
    if (
      root === null || typeof root !== 'object' || Array.isArray(root) ||
      (root as Json).room_id !== id
    ) {
      failure = new MatrixError(
        502,
        'M_UNKNOWN',
        'invalid remote hierarchy summary',
      );
      continue;
    }
    const summary = root as Json;
    if (await summaryAccessible(summary, { user })) {
      const inaccessible = (response as Json).inaccessible_children;
      return {
        room: summary,
        inaccessible: Array.isArray(inaccessible)
          ? inaccessible.filter((id): id is string => typeof id === 'string')
          : [],
      };
    }
    return null;
  }
  if (failure !== undefined) throw failure;
  return null;
}

export async function remoteDiscoverySummary(
  id: string,
  user: string,
  via: readonly string[],
): Promise<Json | null> {
  return (await remoteDiscoveryHierarchy(id, user, via))?.room ?? null;
}

export async function roomSummary(
  idOrAlias: string,
  user: string | null,
  via: readonly string[],
) {
  let id = idOrAlias;
  let candidates = [...via];
  if (idOrAlias.startsWith('#')) {
    // Optional anonymous summaries use held data only, even though directory
    // lookup itself may contact remote servers under the user's P01 ruling.
    if (user === null && domainOf(idOrAlias) !== serverName()) throw missing();
    const alias = await resolveAlias(idOrAlias);
    id = alias.room_id;
    candidates = [...candidates, ...alias.servers];
  }
  if (!id.startsWith('!')) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'invalid room identifier');
  }
  let summary = await localDiscoverySummary(id, { user });
  if (summary === null && await lookupRoom(id) === null && user !== null) {
    if (candidates.length === 0 && domainOf(id) !== null) {
      candidates.push(domainOf(id)!);
    }
    summary = await remoteDiscoverySummary(id, user, candidates);
  }
  if (summary === null) throw missing();
  const out = { ...summary };
  delete out.children_state;
  if (user !== null) {
    out.membership =
      (await membershipOf(theApp().server, id, user))?.membership ?? 'leave';
  }
  return out;
}

function missing() {
  return new MatrixError(404, 'M_NOT_FOUND', 'room not found');
}
