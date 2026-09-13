import { parseJson } from '@pathfinder/pathfinder/body';
import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { deleteDevices, getDevice } from '#engine/tenant.ts';
import { requireUia, PASSWORD_FLOWS } from '#engine/uia.ts';
import { localpartOf } from '#engine/auth.ts';
import type { PathfinderRequest, Context } from '@pathfinder/pathfinder';

// DELETE /_matrix/client/v3/devices/{deviceId} — "This API endpoint uses
// the User-Interactive Authentication API. Deletes the given device, and
// invalidates any access token associated with it." (spec v1.11, Device
// Management.) The 401 carries flows/params/session per the UIA contract;
// a wrong password is a 401 M_FORBIDDEN. 404 when the device is unknown or
// not owned by the caller. Response: {}.
export default async function (request: PathfinderRequest, context: Context) {
  const caller = context.state.user as string;
  const localpart = localpartOf(caller);
  await requireUia({
    serverName: serverName(),
    body: await parseJson(request) as Record<string, unknown>,
    flows: PASSWORD_FLOWS,
    caller,
  });
  const deviceId = request.params.deviceId as string;
  const device = await getDevice(serverName(), localpart, deviceId);
  if (device === null) throw new MatrixError(404, 'M_NOT_FOUND', 'unknown device');
  await deleteDevices(serverName(), localpart, [deviceId]);
  return {};
}