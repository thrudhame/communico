import { MatrixError } from '#engine/matrix-error.ts';
import { createRoom, type CreateRoomOptions } from '#engine/client/write.ts';
import { parseJson } from '#engine/operation-body.ts';

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
    creator: context.state.user as string,
    version: body.room_version as string | undefined,
    preset: body.preset as string | undefined,
    visibility: body.visibility as string | undefined,
    name: body.name as string | undefined,
    topic: body.topic as string | undefined,
    invite: body.invite as string[] | undefined,
    invite_3pid: body.invite_3pid as unknown[] | undefined,
    is_direct: body.is_direct as boolean | undefined,
    alias: body.room_alias_name as string | undefined,
    creation_content: body.creation_content as
      | Record<string, unknown>
      | undefined,
    initial_state: body.initial_state as {
      type: string;
      state_key?: string;
      content: unknown;
    }[] | undefined,
    power_level_content_override: body.power_level_content_override as
      | Record<string, unknown>
      | undefined,
  };
  try {
    const res = await createRoom(opts);
    const out: Record<string, unknown> = { room_id: res.roomId };
    if (res.roomAlias !== undefined) out.room_alias = res.roomAlias;
    return out;
  } catch (e) {
    if (e instanceof MatrixError) throw e;
    const msg = String(e);
    if (msg.includes('M_UNSUPPORTED_ROOM_VERSION')) {
      throw new MatrixError(400, 'M_UNSUPPORTED_ROOM_VERSION', msg);
    }
    if (msg.includes('E_CREATE_ROOM_REJECT')) {
      throw new MatrixError(400, 'M_INVALID_PARAM', msg);
    }
    throw new MatrixError(500, 'M_UNKNOWN', msg);
  }
}
