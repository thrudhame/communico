import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { createHttpError, Status } from '@oak/oak';
import { authorize } from '../../../../../engine/auth.ts';
import { MatrixError } from '../../../../../engine/matrix-error.ts';
import { supportedRoomVersions } from '../../../../../engine/policy.ts';

// M0: server capabilities (Complement 10apidoc/45server-capabilities).
// Room versions: 11 only ('12' when its resolver lands at M3).
// m.change_password is advertised DISABLED (no endpoint exists — the
// plan's "no m.change_password" means no endpoint, not no key: the
// capabilities test requires the key present). Auth required (401
// otherwise — the same test asserts unauthenticated calls fail).
export default async function (
  request: TApiComponentRequest,
): TApiComponentOutcome {
  try {
    await authorize(request);
    const available: Record<string, string> = {};
    for (const v of supportedRoomVersions()) available[v] = 'stable';
    return [null, {
      capabilities: {
        'm.room_versions': { default: '11', available },
        'm.change_password': { enabled: false },
      },
    }];
  } catch (e) {
    if (e instanceof MatrixError) throw e;
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }
}
