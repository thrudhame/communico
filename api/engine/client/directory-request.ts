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
import { parseIp } from '#engine/preview/cidr.ts';

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

export function directoryDestination(
  query: URLSearchParams,
): string | undefined {
  const server = query.get('server');
  if (server === null || server === '') return undefined;
  const match = /^(\[[0-9a-fA-F:.]+\]|[0-9A-Za-z.-]+)(?::([0-9]{1,5}))?$/.exec(
    server,
  );
  if (
    match === null ||
    (match[1].startsWith('[') && parseIp(match[1].slice(1, -1)) === null) ||
    (match[2] !== undefined &&
      (Number(match[2]) < 1 || Number(match[2]) > 65535))
  ) invalidParameter('server');
  return server;
}

// Encode the normalized request once for either federation method. Preserve
// extension filters and opaque tokens; never interpret a remote cursor locally.
export function directoryWireRequest(
  request: DirectoryRequest,
): Record<string, unknown> {
  return {
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.since === undefined ? {} : { since: request.since }),
    ...(request.filter === undefined ? {} : { filter: request.filter }),
    ...(request.network.kind === 'all' ? { include_all_networks: true } : {}),
    ...(request.network.kind === 'instance'
      ? { third_party_instance_id: request.network.id }
      : {}),
  };
}
