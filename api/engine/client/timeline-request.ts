import { MatrixError } from '#engine/matrix-error.ts';
import {
  enumParameter,
  objectParameter,
  queryInteger,
  requiredParameter,
} from '#engine/operation.ts';
import { roomEventFilterOf } from '#engine/tenant/filters.ts';

export function decodeTimelineWindow(query: URLSearchParams) {
  let raw: unknown = {};
  const value = query.get('filter');
  if (value !== null) {
    try {
      raw = JSON.parse(value);
    } catch {
      throw new MatrixError(400, 'M_BAD_JSON', 'filter is not valid JSON');
    }
  }
  const filter = roomEventFilterOf(raw);
  const body = objectParameter(raw, 'filter');
  return {
    limit: queryInteger(query.get('limit'), 'limit', 0) ?? 10,
    filter,
    lazyLoadMembers: body.lazy_load_members === true,
  };
}

export function decodeMessagesRequest(query: URLSearchParams) {
  return {
    ...decodeTimelineWindow(query),
    dir: requiredParameter(
      enumParameter(query.get('dir') ?? undefined, 'dir', ['b', 'f']),
      'dir',
    ),
    fromToken: query.get('from'),
    toToken: query.get('to'),
  };
}
