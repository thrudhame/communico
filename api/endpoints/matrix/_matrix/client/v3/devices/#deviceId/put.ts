import { parseJson } from '@pathfinder/pathfinder/body';
import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getDevice, updateDeviceName } from '#engine/tenant.ts';
import { localpartOf } from '#engine/auth.ts';
import type { PathfinderRequest, Context } from '@pathfinder/pathfinder';

// PUT /_matrix/client/v3/devices/{deviceId} — "Updates the device's display
// name." (spec v1.11, Device Management). Body: {display_name?} — "If not
// given, the display name is unchanged." 404 when the device is unknown or
// not owned by the caller. Response: {}.
export default async function (request: PathfinderRequest, context: Context) {
  const body = await parseJson(request) as { display_name?: unknown };
  const userId = context.state.user as string;
  const localpart = localpartOf(userId);
  const deviceId = request.params.deviceId as string;
  if (body.display_name === undefined) {
    // Spec: name unchanged — ownership still decides 200 vs 404.
    const device = await getDevice(serverName(), localpart, deviceId);
    if (device === null) throw new MatrixError(404, 'M_NOT_FOUND', 'unknown device');
    return {};
  }
  if (typeof body.display_name !== 'string') {
    throw new MatrixError(400, 'M_BAD_JSON', 'display_name must be a string');
  }
  const ok = await updateDeviceName(serverName(), localpart, deviceId, body.display_name);
  if (!ok) throw new MatrixError(404, 'M_NOT_FOUND', 'unknown device');
  return {};
}
