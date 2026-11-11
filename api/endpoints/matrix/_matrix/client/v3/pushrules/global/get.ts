import { localpartOf } from '#engine/tenant/auth.ts';
import { rulesetFor } from '#engine/tenant/pushrules.ts';
import { theApp } from '#engine/app.ts';

export default function (
  _request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return rulesetFor(theApp().tenant, localpartOf(context.state.user as string));
}
