import { serverName } from '#engine/config.ts';
import { listPushers } from '#engine/tenant.ts';
import { localpartOf } from '#engine/auth.ts';
import type { Context } from '@pathfinder/pathfinder';

// GET /_matrix/client/v3/pushers — "Gets all currently active pushers for
// the authenticated user." (spec v1.11, Push Notifications.) Response:
// {pushers: [{app_id, pushkey, kind, app_display_name,
// device_display_name, profile_tag?, lang, data}]} — access_token is never
// returned.
// deno-lint-ignore require-await
export default async function (_request: unknown, context: Context) {
  const caller = context.state.user as string;
  const pushers = await listPushers(serverName(), localpartOf(caller));
  return {
    pushers: pushers.map((p) => ({
      app_id: p.app_id,
      pushkey: p.pushkey,
      kind: p.kind,
      app_display_name: p.app_display_name,
      device_display_name: p.device_display_name,
      ...(p.profile_tag !== null ? { profile_tag: p.profile_tag } : {}),
      lang: p.lang,
      data: p.data,
    })),
  };
}
