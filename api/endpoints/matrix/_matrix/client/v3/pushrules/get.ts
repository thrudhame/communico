import { localpartOf } from '#engine/auth.ts';
import { rulesetFor } from '#engine/pushrules.ts';

// GET /_matrix/client/v3/pushrules/ — the user's rulesets (spec v1.16
// pushrules.yaml:19-46; plan D9). Currently the only ruleset is `global`.
export default async function (
  _request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return {
    global: await rulesetFor(localpartOf(context.state.user as string)),
  };
}
