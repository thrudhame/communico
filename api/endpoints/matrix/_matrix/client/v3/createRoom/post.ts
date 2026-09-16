import { MatrixError } from '#engine/matrix-error.ts';
import { createRoom, type CreateRoomOptions } from '#engine/room.ts';
import { serverName } from '#engine/config.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// POST /_matrix/client/v3/createRoom — M4 options path (spec
// create_room.yaml at v1.16). room_version defaults to '11'; a
// non-string version is 400 M_BAD_JSON, an unknown one 400
// M_UNSUPPORTED_ROOM_VERSION (never a silent default).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  let body: Record<string, unknown> = {};
  try {
    body = (await parseJson(request)) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof Error && e.name === 'ParseError') body = {};
    else throw e;
  }
  if (
    body.room_version !== undefined && typeof body.room_version !== 'string'
  ) {
    throw new MatrixError(400, 'M_BAD_JSON', 'room_version must be a string');
  }
  const opts: CreateRoomOptions = {
    roomVersion: body.room_version as string | undefined,
    preset: body.preset as string | undefined,
    visibility: body.visibility as string | undefined,
    name: body.name as string | undefined,
    topic: body.topic as string | undefined,
    invite: body.invite as string[] | undefined,
    roomAliasName: body.room_alias_name as string | undefined,
    creationContent: body.creation_content as
      | Record<string, unknown>
      | undefined,
    initialState: body.initial_state as
      | { type: string; state_key?: string; content: unknown }[]
      | undefined,
    powerLevelContentOverride: body.power_level_content_override as
      | Record<string, unknown>
      | undefined,
  };
  const roomId = '!' + crypto.randomUUID() + ':' + serverName();
  try {
    const res = await createRoom(
      roomId,
      context.state.user as string,
      opts,
    );
    const out: Record<string, unknown> = { room_id: roomId };
    if (res.roomAlias !== undefined) out.room_alias = res.roomAlias;
    return out;
  } catch (e) {
    if (e instanceof MatrixError) throw e;
    const msg = String(e);
    if (msg.includes('M_UNSUPPORTED_ROOM_VERSION')) {
      throw new MatrixError(400, 'M_UNSUPPORTED_ROOM_VERSION', msg);
    }
    throw new MatrixError(500, 'M_UNKNOWN', msg);
  }
}
