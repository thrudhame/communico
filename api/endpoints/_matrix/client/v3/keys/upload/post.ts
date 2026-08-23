import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { createHttpError, Status } from '@oak/oak';
import { authorize } from '../../../../../../engine/auth.ts';

// POST /_matrix/client/v3/keys/upload — stub (phase-2 step 2.4; the
// capture lists this endpoint: matrix-commander constructs nio with
// encryption_enabled=True + a store, so nio uploads device keys on its
// first sync). E2EE is out of scope; --plain everywhere.
export default async function (
  request: TApiComponentRequest,
): TApiComponentOutcome {
  try {
    await authorize(request);
    return [null, { one_time_key_counts: {} }];
  } catch (e) {
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }
}
