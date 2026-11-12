import { theApp } from '#engine/app.ts';
import { config, serverName } from '#engine/config.ts';
import { localpartOf, splitId } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  aliasRecord,
  lookupAlias,
  registerAlias,
  removeAlias,
  roomAliases as aliases,
} from '#engine/server/aliases.ts';
import * as directory from '#engine/server/directory.ts';
import { membershipOf } from '#engine/server/read.ts';
import { getProfile } from '#engine/tenant/users.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import {
  parsePowerLevels,
  requiredLevel,
  userPowerLevel,
} from '#engine/rulebook/power-levels.ts';
import { requireRoom, stateAtSeq, versionOf } from './room.ts';
import { joinedRooms, serversInRoom } from './membership.ts';
import { writeStateKey } from './write.ts';
import { discoveryRequest } from '#engine/federation/discovery.ts';
import { directoryResponse } from '#engine/federation/discovery-response.ts';
import { publicRoomSummary } from './summary.ts';
import {
  type DirectoryRequest,
  directoryWireRequest,
  localDirectoryOffset,
} from './directory-request.ts';
import { remoteDirectoryResponse } from './directory-response.ts';

export function aliasIsLocal(alias: string) {
  const parts = splitId(alias);
  return parts.localpart.length > 0 && parts.server === serverName() &&
    alias.startsWith('#');
}
export async function createAlias(
  alias: string,
  roomId: string,
  creator: string,
) {
  if (
    !aliasIsLocal(alias)
  ) throw new MatrixError(400, 'M_INVALID_PARAM', 'Room alias invalid');
  await requireRoom(roomId);
  if (await lookupAlias(theApp().server, alias) !== null) {
    throw new MatrixError(409, 'M_ROOM_IN_USE', 'alias taken: ' + alias);
  }
  await registerAlias(theApp().server, alias, roomId, creator);
}
export async function resolveAlias(alias: string) {
  const parts = splitId(alias), fed = config().federation;
  if (!aliasIsLocal(alias)) {
    if (!fed.enabled || fed.lookups === 'none') {
      throw new MatrixError(404, 'M_NOT_FOUND', 'unknown alias');
    }
    if (
      fed.lookups === 'all' && alias.startsWith('#') &&
      parts.localpart.length > 0 && parts.server !== null &&
      parts.server.length > 0
    ) {
      const answer = await discoveryRequest(
        theApp().server,
        theApp().tenant.signer(),
        {
          destination: parts.server,
          path: '/_matrix/federation/v1/query/directory?room_alias=' +
            encodeURIComponent(alias),
        },
      );
      return directoryResponse(answer);
    }
  }
  const roomId = await lookupAlias(theApp().server, alias);
  if (roomId === null || await directory.purgeable(theApp().server, roomId)) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'Room alias not found');
  }
  const servers = await serversInRoom(roomId);
  if (servers.length === 0) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'Room alias not found');
  }
  return { room_id: roomId, servers };
}
export async function powerFor(roomId: string, user: string, type: string) {
  const room = await requireRoom(roomId),
    spec = getRulebook(await versionOf(room)).spec;
  const rows = await stateAtSeq(roomId, null, [
    ['m.room.power_levels', ''],
    ['m.room.create', ''],
  ]);
  const pdu = async (type: string) => {
    const id = rows.find((r) => r.type === type && r.stateKey === '')?.eventId;
    const row = id === undefined
      ? null
      : await room.tx((tx) => tx.events.get(id));
    return row === null ? null : JSON.parse(row.pdu);
  };
  const pl = await pdu('m.room.power_levels'),
    create = await pdu('m.room.create');
  const parsed = pl === null ? null : parsePowerLevels(pl.content, spec);
  return {
    level: userPowerLevel(user, pl, create, spec),
    need: requiredLevel(type, '', parsed?.ok ? parsed.pl : null),
  };
}
export async function deleteAlias(alias: string, user: string) {
  const db = theApp().server, row = await aliasRecord(db, alias);
  if (row === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'Room alias not found');
  }
  const power = await powerFor(row.roomId, user, 'm.room.canonical_alias');
  if (row.creator !== user && power.level < power.need) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'not the alias creator and insufficient power level',
    );
  }
  const canon =
    (await stateAtSeq(row.roomId, null, [['m.room.canonical_alias', '']])).find(
      (r) => r.type === 'm.room.canonical_alias' && r.stateKey === '',
    );
  await removeAlias(db, alias);
  if (canon !== undefined) {
    const content = { ...canon.content };
    let changed = false;
    if (content.alias === alias) {
      delete content.alias;
      changed = true;
    }
    if (Array.isArray(content.alt_aliases)) {
      const kept = content.alt_aliases.filter((a) => a !== alias);
      if (kept.length !== content.alt_aliases.length) {
        content.alt_aliases = kept;
        changed = true;
      }
    }
    if (changed) {
      try {
        await writeStateKey(
          row.roomId,
          user,
          'm.room.canonical_alias',
          '',
          content,
        );
      } catch (e) {
        console.error(
          'alias delete: canonical_alias update rejected (kept):',
          String(e),
        );
      }
    }
  }
}
export async function roomAliases(roomId: string, user: string) {
  await requireRoom(roomId);
  const m = await membershipOf(theApp().server, roomId, user),
    state = await stateAtSeq(roomId, null, [['m.room.history_visibility', '']]);
  if (
    m?.membership !== 'join' &&
    !state.some((r) =>
      r.type === 'm.room.history_visibility' &&
      r.content.history_visibility === 'world_readable'
    )
  ) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'You are not a member of the room.',
    );
  }
  return await aliases(theApp().server, roomId);
}
export async function getVisibility(roomId: string) {
  await requireRoom(roomId);
  return { visibility: await directory.visibility(theApp().server, roomId) };
}
export async function setVisibility(
  roomId: string,
  user: string,
  value: string,
) {
  await requireRoom(roomId);
  if (value !== 'public' && value !== 'private') {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'unknown visibility: ' + value,
    );
  }
  if (
    (await membershipOf(theApp().server, roomId, user))?.membership !== 'join'
  ) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'You are not a member of the room.',
    );
  }
  await directory.setVisibility(theApp().server, roomId, value);
}
export async function queryDirectory(
  opts: DirectoryRequest,
  destination?: string,
) {
  if (destination === undefined || destination === serverName()) {
    return await listLocalPublishedRooms(opts);
  }
  const fed = config().federation;
  if (!fed.enabled || fed.lookups !== 'all') {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'remote public directory lookup disabled',
    );
  }
  const wire = directoryWireRequest(opts);
  const post = opts.filter !== undefined;
  const query = new URLSearchParams();
  if (!post) {
    for (const [key, value] of Object.entries(wire)) {
      query.set(key, String(value));
    }
  }
  const answer = await discoveryRequest(
    theApp().server,
    theApp().tenant.signer(),
    {
      destination,
      path: '/_matrix/federation/v1/publicRooms' +
        (query.size === 0 ? '' : '?' + query),
      ...(post
        ? {
          method: 'POST' as const,
          body: new TextEncoder().encode(JSON.stringify(wire)),
        }
        : {}),
    },
  );
  return remoteDirectoryResponse(answer);
}

export function assertFederationDirectoryAllowed() {
  if (!config().federation.publicrooms) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'public directory federation disabled',
    );
  }
}

export async function listLocalPublishedRooms(
  opts: DirectoryRequest,
) {
  const limit = opts.limit !== undefined && opts.limit > 0
      ? Math.min(opts.limit, 100)
      : 100,
    offset = localDirectoryOffset(opts.since);
  if (opts.network.kind === 'instance') {
    return { chunk: [], total_room_count_estimate: 0 };
  }
  const roomTypes = opts.filter?.room_types,
    search = opts.filter?.generic_search_term;
  const all: Record<string, unknown>[] = [];
  for (const id of await directory.listedRooms(theApp().server)) {
    const chunk = await publicRoomSummary(id);
    if (
      roomTypes !== undefined &&
      !roomTypes.includes(
        typeof chunk.room_type === 'string' ? chunk.room_type : null,
      )
    ) continue;
    if (
      search !== undefined &&
      ![chunk.name, chunk.topic, chunk.canonical_alias].some((v) =>
        typeof v === 'string' &&
        v.toLowerCase().includes(search.toLowerCase())
      )
    ) continue;
    all.push(chunk);
  }
  all.sort((a, b) =>
    Number(b.num_joined_members) - Number(a.num_joined_members) ||
    String(a.room_id).localeCompare(String(b.room_id))
  );
  const out: {
    chunk: Record<string, unknown>[];
    total_room_count_estimate: number;
    next_batch?: string;
    prev_batch?: string;
  } = {
    chunk: all.slice(offset, offset + limit),
    total_room_count_estimate: all.length,
  };
  if (offset + limit < all.length) out.next_batch = String(offset + limit);
  if (offset > 0) out.prev_batch = String(Math.max(0, offset - limit));
  return out;
}
export async function searchUsers(searcher: string, term: string, limit = 10) {
  const candidates = new Set<string>(),
    publicIds = new Set(await directory.listedRooms(theApp().server));
  for (const id of await directory.allMemberRooms(theApp().server)) {
    if (publicIds.has(id)) continue;
    if (
      (await stateAtSeq(id, null, [['m.room.join_rules', ''], [
        'm.room.history_visibility',
        '',
      ]])).some((r) =>
        (r.type === 'm.room.join_rules' && r.content.join_rule === 'public') ||
        (r.type === 'm.room.history_visibility' &&
          r.content.history_visibility === 'world_readable')
      )
    ) publicIds.add(id);
  }
  for (const id of new Set([...publicIds, ...await joinedRooms(searcher)])) {
    for (const user of await directory.joinedUsers(theApp().server, id)) {
      candidates.add(user);
    }
  }
  candidates.delete(searcher);
  const needle = term.toLowerCase(), results: Record<string, unknown>[] = [];
  for (const user of candidates) {
    if (!user.endsWith(':' + serverName())) continue;
    const profile = await getProfile(
      theApp().tenant,
      localpartOf(user),
    );
    if (
      !user.toLowerCase().includes(needle) &&
      !profile?.displayname?.toLowerCase().includes(needle)
    ) continue;
    const result: Record<string, unknown> = { user_id: user };
    if (profile?.displayname !== undefined) {
      result.display_name = profile.displayname;
    }
    if (profile?.avatar_url !== undefined) {
      result.avatar_url = profile.avatar_url;
    }
    results.push(result);
  }
  results.sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)));
  return { results: results.slice(0, limit), limited: results.length > limit };
}
