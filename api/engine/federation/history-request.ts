import {
  integerParameter,
  invalidParameter,
  objectParameter,
  queryInteger,
  requiredParameter,
  stringArrayParameter,
} from '#engine/operation.ts';

export function backfillArguments(roots: unknown, count: unknown) {
  const v = requiredParameter(stringArrayParameter(roots, 'v'), 'v');
  if (v.length === 0) invalidParameter('v');
  return {
    v,
    limit: requiredParameter(integerParameter(count, 'limit'), 'limit'),
  };
}
export function backfillRequest(query: URLSearchParams) {
  return backfillArguments(
    query.getAll('v'),
    queryInteger(query.get('limit'), 'limit'),
  );
}
export function missingEventsRequest(value: unknown) {
  const raw = objectParameter(value, 'body');
  const limit = integerParameter(raw.limit, 'limit');
  const minDepth = integerParameter(raw.min_depth, 'min_depth');
  return {
    earliest: requiredParameter(
      stringArrayParameter(raw.earliest_events, 'earliest_events'),
      'earliest_events',
    ),
    latest: requiredParameter(
      stringArrayParameter(raw.latest_events, 'latest_events'),
      'latest_events',
    ),
    limit: limit === undefined ? 10 : limit,
    minDepth: minDepth === undefined ? 0 : minDepth,
  };
}
