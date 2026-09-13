import { parseJson } from '@pathfinder/pathfinder/body';
import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { setPusher } from '#engine/tenant.ts';
import { localpartOf } from '#engine/auth.ts';
import type { PathfinderRequest, Context } from '@pathfinder/pathfinder';

// POST /_matrix/client/v3/pushers/set — "This endpoint updates the pusher
// associated with app_id and pushkey for the authenticated user."
// (spec v1.11, Push Notifications.) Required: app_id, pushkey; when kind
// is not null also app_display_name, device_display_name, lang, data.
// kind null deletes the pusher. Storage only — data.url is NEVER fetched
// (no gateway traffic in M2). Response: {}.
export default async function (request: PathfinderRequest, context: Context) {
  const body = await parseJson(request) as Record<string, unknown>;
  const str = (v: unknown): string | null => typeof v === 'string' ? v : null;
  const appId = str(body.app_id);
  const pushkey = str(body.pushkey);
  if (appId === null || pushkey === null) {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'app_id and pushkey are required');
  }
  const kind = body.kind === null
    ? null
    : (str(body.kind) ?? (() => {
      throw new MatrixError(400, 'M_MISSING_PARAM', 'kind is required');
    })());
  let pusher: Parameters<typeof setPusher>[3];
  if (kind === null) {
    pusher = {
      app_id: appId,
      pushkey,
      kind: null,
      app_display_name: '',
      device_display_name: '',
      lang: '',
      data: {},
    };
  } else {
    const appDisplayName = str(body.app_display_name);
    const deviceDisplayName = str(body.device_display_name);
    const lang = str(body.lang);
    const data = body.data !== null && typeof body.data === 'object'
      ? body.data
      : null;
    if (
      appDisplayName === null || deviceDisplayName === null || lang === null ||
      data === null
    ) {
      throw new MatrixError(
        400,
        'M_MISSING_PARAM',
        'app_display_name, device_display_name, lang and data are required when kind is not null',
      );
    }
    pusher = {
      app_id: appId,
      pushkey,
      kind,
      app_display_name: appDisplayName,
      device_display_name: deviceDisplayName,
      profile_tag: str(body.profile_tag),
      lang,
      data,
    };
  }
  const caller = context.state.user as string;
  await setPusher(
    serverName(),
    localpartOf(caller),
    context.state.token as string,
    pusher,
  );
  return {};
}
