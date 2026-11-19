import authenticate from '#engine/auth-context.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import type { Tenant } from '#engine/tenant/index.ts';
import { localpartOf } from '#engine/ids.ts';
import { theApp } from '#engine/app.ts';
import { requireNotificationHistory } from '#engine/server/notifications.ts';

export default async function (request: PathfinderRequest, context: Context) {
  await authenticate(request, context);
  await (context.state.tenant as Tenant).tx((tx) =>
    tx.ingress.check({
      kind: 'domain',
      localpart: localpartOf(context.state.user as string),
      feature: 'notifications',
    })
  );
  await requireNotificationHistory(
    theApp().server,
    context.state.user as string,
  );
}
