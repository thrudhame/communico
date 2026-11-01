import { localpartOf } from '#engine/tenant/auth.ts';
import { rulesetFor } from '#engine/tenant/pushrules.ts';
import { theApp } from '#engine/app.ts';

// GET /_matrix/client/v3/pushrules/ — the user's rulesets (spec v1.16
// pushrules.yaml:19-46; plan D9). Currently the only ruleset is `global`.
export default async function (
  _request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return {
    global: await rulesetFor(
      theApp().tenant,
      localpartOf(context.state.user as string),
    ),
  };
}
