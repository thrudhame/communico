import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { createHttpError, Status } from '@oak/oak';
import { authorize } from '../../../../../engine/auth.ts';
import { SERVER_NAME } from '../../../../../engine/config.ts';
import { MatrixError } from '../../../../../engine/matrix-error.ts';
import { listDevices } from '../../../../../engine/tenant.ts';

// GET /_matrix/client/v3/devices — the caller's devices (F1 logout gate
// reads this before/after logout). Shape: {devices: [{device_id,
// display_name?}]}.
export default async function (
  request: TApiComponentRequest,
): TApiComponentOutcome {
  try {
    const userId = await authorize(request);
    const localpart = userId.slice(1, userId.lastIndexOf(':'));
    const devices = await listDevices(SERVER_NAME, localpart);
    return [null, {
      devices: devices.map((d) => ({
        device_id: d.device_id,
        ...(d.display_name !== null ? { display_name: d.display_name } : {}),
      })),
    }];
  } catch (e) {
    if (e instanceof MatrixError) throw e;
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }
}
