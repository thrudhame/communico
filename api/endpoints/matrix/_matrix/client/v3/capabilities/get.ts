import { supportedRoomVersions } from '#engine/policy.ts';
import { config } from '#engine/config.ts';

// Capability discovery includes the legacy profile flags required alongside
// m.profile_fields. Authentication is enforced by this folder's middleware.
// deno-lint-ignore require-await
export default async function (
  _request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  void context;
  const available: Record<string, string> = {};
  for (const v of supportedRoomVersions()) available[v] = 'stable';
  return {
    capabilities: {
      'm.room_versions': { default: '11', available },
      'm.change_password': { enabled: false },
      'm.profile_fields': { enabled: true },
      'm.set_displayname': { enabled: true },
      'm.set_avatar_url': { enabled: true },
      'org.matrix.msc4140.delayed_events': {
        max_delay_ms: config().delayedevents.maxdelayms,
        max_scheduled: config().delayedevents.maxperuser,
      },
    },
  };
}
