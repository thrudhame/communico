import { MatrixError } from '#engine/matrix-error.ts';
import { optionalField } from '#engine/net/json.ts';

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
  const result = { ...value };
  for (const token of ['next_batch', 'prev_batch']) {
    const decoded = optionalField(value[token], (raw) => {
      if (typeof raw !== 'string') return bad();
      return raw;
    });
    if (decoded === undefined) delete result[token];
    else result[token] = decoded;
  }
  const total = optionalField(value.total_room_count_estimate, (raw) => {
    if (!count(raw)) return bad();
    return raw;
  });
  if (total === undefined) delete result.total_room_count_estimate;
  else result.total_room_count_estimate = total;
  result.chunk = value.chunk.map((entry) => {
    if (
      !object(entry) || typeof entry.room_id !== 'string' ||
      !entry.room_id.startsWith('!') ||
      !count(entry.num_joined_members) ||
      typeof entry.world_readable !== 'boolean' ||
      typeof entry.guest_can_join !== 'boolean'
    ) return bad();
    const decoded = { ...entry };
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
      const field = optionalField(entry[key], (raw) => {
        if (typeof raw !== 'string') return bad();
        return raw;
      });
      if (field === undefined) delete decoded[key];
      else decoded[key] = field;
    }
    return decoded;
  });
  return result;
}
