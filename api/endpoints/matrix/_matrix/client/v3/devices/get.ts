import { theApp } from '#engine/app.ts';
import { localpartOf } from '#engine/tenant/auth.ts';
import { listDevices } from '#engine/tenant/devices.ts';

// GET /_matrix/client/v3/devices — the caller's devices (F1 logout gate
// reads this before/after logout). Shape: {devices: [{device_id,
// display_name?}]}.
export default async function (
  _request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const localpart = localpartOf(userId);
  const devices = await listDevices(theApp().tenant, localpart);
  return {
    devices: devices.map((
      d: { device_id: string; display_name: string | null },
    ) => ({
      device_id: d.device_id,
      ...(d.display_name !== null ? { display_name: d.display_name } : {}),
    })),
  };
}
