// Shared create/upgrade input admission. Unknown versions never fall back;
// v12 creator lists are validated whole, never repaired by filtering entries.
import { MatrixError } from '#engine/matrix-error.ts';
import { getRulebook, supportedRoomVersions } from '#engine/rulebook/index.ts';
import { validAdditionalCreators } from '#engine/rulebook/auth-rules.ts';
import type { RoomVersionSpec } from '#engine/rulebook/types.ts';

export function creationVersion(raw: unknown, field: string) {
  if (raw === undefined) {
    throw new MatrixError(400, 'M_MISSING_PARAM', field + ' is required');
  }
  if (typeof raw !== 'string') {
    throw new MatrixError(400, 'M_BAD_JSON', field + ' must be a string');
  }
  if (!supportedRoomVersions().includes(raw)) {
    throw new MatrixError(
      400,
      'M_UNSUPPORTED_ROOM_VERSION',
      'This server does not support that room version',
    );
  }
  return { version: raw, spec: getRulebook(raw).spec };
}

export function creationCreators(
  spec: RoomVersionSpec,
  raw: unknown,
): string[] {
  if (!spec.additionalCreators || raw === undefined) return [];
  if (!validAdditionalCreators(raw)) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'additional_creators is not an array of valid user IDs',
    );
  }
  return [...raw as string[]];
}
