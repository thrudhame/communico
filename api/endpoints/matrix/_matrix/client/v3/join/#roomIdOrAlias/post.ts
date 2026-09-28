import { MatrixError } from '#engine/matrix-error.ts';
import { join } from '#engine/membership.ts';
import { lookupAlias } from '#engine/room.ts';
import { domainOf } from '#engine/federation/pdu.ts';
import { federationRequest } from '#engine/federation/client.ts';
import { serverName } from '#engine/config.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// POST /_matrix/client/v3/join/#roomIdOrAlias — join by room id or alias
// (data/api/client-server/joining.yaml:19-60). Body keys merge into the
// member content. M5b (§3.6, design point C): `via` when present, else
// the legacy `server_name` (Synapse's precedence) — a remote alias is
// queried at the alias's server (an authenticated user's deliberate act,
// roster growth by intent).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const idOrAlias = request.params.roomIdOrAlias as string;
  const via = request.query.getAll('via');
  const serverNameParam = request.query.getAll('server_name');
  const body = (await parseJson(request).catch(() => ({}))) as Record<
    string,
    unknown
  >;

  let roomId = idOrAlias;
  const remoteCandidates: string[] = [];
  if (idOrAlias.startsWith('#')) {
    const resolved = await lookupAlias(idOrAlias);
    if (resolved !== null) {
      roomId = resolved;
    } else {
      // a remote alias: query the alias's server (§3.6 step 1)
      const aliasServer = domainOf(idOrAlias);
      if (aliasServer === serverName()) {
        throw new MatrixError(
          404,
          'M_NOT_FOUND',
          'unknown alias: ' + idOrAlias,
        );
      }
      const res = await federationRequest({
        destination: aliasServer,
        method: 'GET',
        path: `/_matrix/federation/v1/query/directory?room_alias=${
          encodeURIComponent(idOrAlias)
        }`,
        body: null,
      });
      const j = res.json as { room_id?: unknown; servers?: unknown };
      if (typeof j.room_id !== 'string') {
        throw new MatrixError(
          404,
          'M_NOT_FOUND',
          'unknown alias: ' + idOrAlias,
        );
      }
      roomId = j.room_id;
      remoteCandidates.push(
        aliasServer,
        ...(Array.isArray(j.servers) ? j.servers.map(String) : []),
      );
    }
  }
  remoteCandidates.push(...(via.length > 0 ? via : serverNameParam));
  // the room id's domain is a candidate for ≤ v11 (tuwunel
  // api/client/membership/join.rs:69)
  remoteCandidates.push(domainOf(roomId));

  // held or not: membership.join dispatches per §3.6b (live → local;
  // archived → reopen or remote by the server list; never held → the
  // remote dance with the inviter's server among the candidates)
  const res = await join(roomId, userId, body, {
    via: [...new Set(remoteCandidates)].filter((d) => d !== serverName()),
  });
  return { room_id: res.roomId };
}
