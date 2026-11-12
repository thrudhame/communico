import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { theApp } from '#engine/app.ts';
import { requestedDelay } from '#engine/delayed-events.ts';
import { authorize, authorizeFull } from '#engine/auth-context.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

export async function scheduleDelayed(
  request: PathfinderRequest,
  context: Context,
  content: Record<string, unknown>,
  stateKey: string | null,
  txnId?: string,
) {
  const delay = requestedDelay(request.query);
  if (delay === null) return null;
  return await theApp().delayedEvents.schedule({
    userId: context.state.user as string,
    roomId: request.params.roomId as string,
    type: request.params.type as string,
    stateKey,
    content,
    delay,
    txnId,
    deviceId: (context.state.device as string | undefined) ?? null,
    generation: context.state.deviceGeneration,
  });
}
export async function listDelayed(request: PathfinderRequest) {
  return await theApp().delayedEvents.list(
    await authorize(request),
    request.params.delayId as string | undefined,
  );
}
export async function updateDelayed(request: PathfinderRequest) {
  if (
    request.headers.has('Authorization') || request.query.has('access_token')
  ) await authorizeFull(request);
  let action: unknown = request.params.action;
  if (action === undefined) {
    const body = await parseJson(request) as Record<string, unknown>;
    if (!body || !Object.hasOwn(body, 'action')) {
      throw new MatrixError(400, 'M_MISSING_PARAM', 'action is missing');
    }
    action = body.action;
  }
  return await theApp().delayedEvents.action(
    request.params.delayId as string,
    action,
  );
}
