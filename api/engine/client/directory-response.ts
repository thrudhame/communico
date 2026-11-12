import { MatrixError } from '#engine/matrix-error.ts';

// A remote page is discovery metadata, not room membership or local publication.
// Validate the whole page before exposing any of it; retain optional extensions.
export function remoteDirectoryResponse(
  value: unknown,
): Record<string, unknown> {
  const object = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  const count = (v: unknown) =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const bad = () => {
    throw new MatrixError(
      502,
      'M_UNKNOWN',
      'invalid remote public directory response',
    );
  };
  if (!object(value) || !Array.isArray(value.chunk)) return bad();
  for (const token of ['next_batch', 'prev_batch']) {
    if (value[token] !== undefined && typeof value[token] !== 'string') {
      return bad();
    }
  }
  if (
    value.total_room_count_estimate !== undefined &&
    !count(value.total_room_count_estimate)
  ) return bad();
  for (const entry of value.chunk) {
    if (
      !object(entry) || typeof entry.room_id !== 'string' ||
      !entry.room_id.startsWith('!') ||
      !count(entry.num_joined_members) ||
      typeof entry.world_readable !== 'boolean' ||
      typeof entry.guest_can_join !== 'boolean'
    ) return bad();
    for (
      const key of [
        'name',
        'topic',
        'canonical_alias',
        'avatar_url',
        'room_type',
        'join_rule',
      ]
    ) {
      if (entry[key] !== undefined && typeof entry[key] !== 'string') {
        return bad();
      }
    }
  }
  return value;
}
