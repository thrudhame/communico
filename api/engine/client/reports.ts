import { theApp } from '#engine/app.ts';
import { serverName } from '#engine/config.ts';
import { splitId } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { membershipOf, redactionOf } from '#engine/server/read.ts';
import { type ReportKind, storeReport } from '#engine/server/reports.ts';
import { lookupRoom, requireRoom } from './room.ts';
import { canSeeEvent } from './visibility.ts';

export async function reportContent(
  kind: ReportKind,
  reporter: string,
  target: string,
  body: unknown,
  eventId?: string,
) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new MatrixError(400, 'M_BAD_JSON', 'expected an object');
  }
  const input = body as Record<string, unknown>;
  if (
    (kind !== 'event' || input.reason !== undefined) &&
    typeof input.reason !== 'string'
  ) {
    throw new MatrixError(400, 'M_BAD_JSON', 'reason must be a string');
  }
  if (
    kind === 'event' && input.score !== undefined &&
    !Number.isInteger(input.score)
  ) {
    throw new MatrixError(400, 'M_BAD_JSON', 'score must be an integer');
  }
  const app = theApp();
  const details = { reporter, reason: input.reason as string | undefined };
  if (kind === 'user') {
    const parsed = splitId(target);
    if (!target.startsWith('@') || !parsed.localpart || !parsed.server) {
      throw new MatrixError(400, 'M_INVALID_PARAM', 'invalid user id');
    }
    // Match standard servers: do not disclose unknown/nonlocal user existence.
    if (parsed.server !== serverName()) return {};
    const user = await app.tenant.tx((tx) =>
      tx.users.byLocalpart(parsed.localpart)
    );
    if (user === null) return {};
    await storeReport(app.server, { kind, userId: target, ...details });
  } else {
    await withRoomLock(target, async () => {
      if (kind === 'room') {
        await requireRoom(target);
        await storeReport(app.server, { kind, roomId: target, ...details });
        return;
      }
      const room = await lookupRoom(target);
      if (
        room === null || eventId === undefined ||
        (await membershipOf(app.server, target, reporter))?.membership !==
          'join' ||
        !await canSeeEvent(reporter, room, eventId) ||
        await redactionOf(app.server, target, eventId) !== null
      ) {
        throw new MatrixError(
          404,
          'M_NOT_FOUND',
          'event not found or you are not joined',
        );
      }
      await storeReport(app.server, {
        kind,
        roomId: target,
        eventId,
        ...details,
        score: input.score as number | undefined,
      });
    });
  }
  return {};
}
