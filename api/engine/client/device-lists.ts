import { theApp } from '#engine/app.ts';
import { parseStreamToken } from '#engine/client/tokens.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  deviceListsBetween,
  deviceListSnapshot,
  deviceStreamMax,
} from '#engine/server/e2ee.ts';
import { recoveryState } from '#engine/server/recovery.ts';

export async function keyChanges(
  user: string,
  from: string | null,
  to: string | null,
) {
  const start = from === null ? null : parseStreamToken(from);
  const end = to === null ? null : parseStreamToken(to);
  const server = theApp().server;
  const epoch = (await recoveryState(server))?.epoch;
  if (
    start !== null && end !== null &&
    (start.epoch !== epoch || end.epoch !== epoch)
  ) {
    return await deviceListSnapshot(
      server,
      user,
      'keys',
      await deviceStreamMax(server),
    );
  }
  if (
    start === null || end === null || start.dSeq > end.dSeq ||
    end.dSeq > await deviceStreamMax(server)
  ) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'invalid device change interval',
    );
  }
  return await deviceListsBetween(server, user, start.dSeq, end.dSeq, 'keys');
}
