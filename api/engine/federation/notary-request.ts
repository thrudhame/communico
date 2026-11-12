import {
  integerParameter,
  objectParameter,
  queryInteger,
  requiredParameter,
} from '#engine/operation.ts';

export function notaryGetFloor(query: URLSearchParams, now = Date.now()) {
  const floor = queryInteger(
    query.get('minimum_valid_until_ts'),
    'minimum_valid_until_ts',
  );
  return floor === undefined ? now : floor;
}
export function notaryRequests(value: unknown, now = Date.now()) {
  const raw = objectParameter(value, 'body');
  const servers = objectParameter(
    requiredParameter(raw.server_keys, 'server_keys'),
    'server_keys',
  );
  return Object.entries(servers).map(([server, keys]) => {
    const criteria = objectParameter(keys, 'server_keys.' + server);
    let minimum: number | undefined;
    for (const [key, value] of Object.entries(criteria)) {
      const field = 'server_keys.' + server + '.' + key;
      const criterion = objectParameter(value, field);
      const requested = integerParameter(
        criterion.minimum_valid_until_ts,
        field + '.minimum_valid_until_ts',
      );
      const floor = requested === undefined ? now : requested;
      minimum = minimum === undefined ? floor : Math.max(minimum, floor);
    }
    // A single cached document is returned for all requested IDs. It must meet
    // every criterion, not only the least demanding key's validity floor.
    return { server, minimum: minimum === undefined ? now : minimum };
  });
}
