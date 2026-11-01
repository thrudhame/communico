import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getDevice } from '#engine/tenant/devices.ts';
import { localpartOf } from '#engine/tenant/auth.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

// GET /_matrix/client/v3/devices/{deviceId} — "Gets information on a single
// device, by device id." (spec v1.11, Device Management). 404 when the
// device is unknown or not owned by the caller. Response: {device_id,
// display_name} — display_name omitted when null.
export default async function (request: PathfinderRequest, context: Context) {
  const userId = context.state.user as string;
  const localpart = localpartOf(userId);
  const deviceId = request.params.deviceId as string;
  const device = await getDevice(theApp().tenant, localpart, deviceId);
  if (device === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'unknown device');
  }
  return {
    device_id: device.device_id,
    ...(device.display_name !== null
      ? { display_name: device.display_name }
      : {}),
  };
}
