import { theApp } from '#engine/app.ts';
import { whois } from '#engine/tenant/whois.ts';

export default function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return whois(
    theApp().tenant,
    context.state.user as string,
    request.params.userId as string,
  );
}
