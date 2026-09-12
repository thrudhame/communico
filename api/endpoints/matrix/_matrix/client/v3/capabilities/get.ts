import { supportedRoomVersions } from '#engine/policy.ts';

// M0: server capabilities (Complement 10apidoc/45server-capabilities).
// Room versions: 11 only ('12' when its resolver lands at M3).
// m.change_password is advertised DISABLED (no endpoint exists — the
// plan's "no m.change_password" means no endpoint, not no key: the
// capabilities test requires the key present). Auth required (401
// otherwise — the same test asserts unauthenticated calls fail; the
// 20-auth middleware enforces it).
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
    },
  };
}
