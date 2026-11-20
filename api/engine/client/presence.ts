// Client admission composes room readiness before the server-owned visibility
// snapshot. Raw internal presence storage is not a client disclosure API.
import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { presenceFor } from '#engine/server/ephemeral.ts';
import { completionAudience, roomCompletion } from './completion.ts';
import type { ReplicaRoomAdmission } from '#engine/facade/directory.ts';

export async function getPresence(
  observer: string,
  subject: string,
  signal?: AbortSignal,
) {
  const app = theApp();
  const admissions: ReplicaRoomAdmission[] = [];
  if (observer !== subject) {
    await app.replica?.requireReadScope('rooms');
    const rooms = await completionAudience(app, observer);
    for (const room of rooms) {
      const admission = await app.replica?.prepareReadRoomScope(room);
      if (admission) admissions.push(admission);
    }
    await roomCompletion(app, rooms, signal);
  }
  const row =
    (await presenceFor(app.server, observer, [subject], async (tx) => {
      signal?.throwIfAborted();
      for (const admission of admissions) await admission.check(tx);
    })).get(subject);
  if (row === undefined) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'You are not allowed to see their presence.',
    );
  }
  return row;
}
