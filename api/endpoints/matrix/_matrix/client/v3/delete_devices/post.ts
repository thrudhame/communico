import { parseJson } from '@pathfinder/pathfinder/body';
import { localpartOf } from '#engine/auth.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { serverName } from '#engine/config.ts';
import { deleteDevices } from '#engine/tenant.ts';
import { PASSWORD_FLOWS, requireUia } from '#engine/uia.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

// POST /_matrix/client/v3/delete_devices — "Deletes the given devices, and
// invalidates any access token associated with them." (spec v1.11, Device
// Management.) Uses the User-Interactive Authentication API. Body:
// {devices: [deviceId], auth?}. Response: {}.
export default async function (request: PathfinderRequest, context: Context) {
  const body = await parseJson(request) as { devices?: unknown };
  if (!Array.isArray(body.devices)) {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'devices required');
  }
  const deviceIds = body.devices as unknown[];
  for (const d of deviceIds) {
    if (typeof d !== 'string') {
      throw new MatrixError(
        400,
        'M_BAD_JSON',
        'devices must be a list of device ids',
      );
    }
  }
  const caller = context.state.user as string;
  await requireUia({
    serverName: serverName(),
    body,
    flows: PASSWORD_FLOWS,
    caller,
  });
  await deleteDevices(
    serverName(),
    localpartOf(caller),
    body.devices as string[],
  );
  return {};
}
