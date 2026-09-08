import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { supportedRoomVersions } from '../../../../../engine/policy.ts';

// M0: server capabilities (Complement 10apidoc/45server-capabilities).
// Room versions: 11 only ('12' when its resolver lands at M3). No
// `m.change_password` (no endpoint exists).
// deno-lint-ignore require-await
export default async function (
  _request: TApiComponentRequest,
): TApiComponentOutcome {
  const available: Record<string, string> = {};
  for (const v of supportedRoomVersions()) available[v] = 'stable';
  return [null, {
    capabilities: {
      'm.room_versions': { default: '11', available },
    },
  }];
}
