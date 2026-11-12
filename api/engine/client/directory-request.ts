import {
  booleanParameter,
  enumParameter,
  integerParameter,
  invalidParameter,
  objectParameter,
  queryBoolean,
  queryInteger,
  stringParameter,
} from '#engine/operation.ts';
import { roomTypesFilter } from './summary.ts';

export type DirectoryNetwork = { kind: 'native' } | { kind: 'all' } | {
  kind: 'instance';
  id: string;
};
export type DirectoryRequest = {
  limit?: number;
  since?: string;
  filter?: Record<string, unknown> & {
    generic_search_term?: string;
    room_types?: (string | null)[];
  };
  network: DirectoryNetwork;
};

// The four HTTP spellings normalize once, before local/remote dispatch. Tokens
// remain opaque here: only their issuing directory can interpret them.
export function decodeDirectoryRequest(
  query: URLSearchParams,
  body?: unknown,
): DirectoryRequest {
  const post = body !== undefined;
  const raw = post ? objectParameter(body, 'body') : {};
  const limit = post
    ? integerParameter(raw.limit, 'limit', 0)
    : queryInteger(query.get('limit'), 'limit', 0);
  const since = post
    ? stringParameter(raw.since, 'since')
    : query.get('since') ?? undefined;
  const all = post
    ? booleanParameter(raw.include_all_networks, 'include_all_networks')
    : queryBoolean(query.get('include_all_networks'), 'include_all_networks');
  const instance = post
    ? stringParameter(raw.third_party_instance_id, 'third_party_instance_id')
    : query.get('third_party_instance_id') ?? undefined;
  if (all === true && instance !== undefined) {
    invalidParameter('include_all_networks + third_party_instance_id');
  }
  let filter: DirectoryRequest['filter'];
  if (raw.filter !== undefined) {
    const value = objectParameter(raw.filter, 'filter');
    filter = {
      ...value,
      ...(value.generic_search_term === undefined ? {} : {
        generic_search_term: stringParameter(
          value.generic_search_term,
          'filter.generic_search_term',
        ),
      }),
      ...(value.room_types === undefined
        ? {}
        : { room_types: roomTypesFilter(value.room_types) }),
    };
  }
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(since === undefined ? {} : { since }),
    ...(filter === undefined ? {} : { filter }),
    network: all
      ? { kind: 'all' }
      : instance !== undefined
      ? { kind: 'instance', id: instance }
      : { kind: 'native' },
  };
}

export function decodeVisibility(body: unknown): 'public' | 'private' {
  return enumParameter(objectParameter(body, 'body').visibility, 'visibility', [
    'public',
    'private',
  ]) ?? 'public';
}

export function localDirectoryOffset(token: string | undefined): number {
  if (token === undefined) return 0;
  if (!/^\d+$/.test(token)) invalidParameter('since');
  return integerParameter(Number(token), 'since', 0)!;
}
