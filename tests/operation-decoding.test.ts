import { assertEquals, assertThrows } from '@std/assert';
import {
  booleanParameter,
  enumParameter,
  integerParameter,
  objectParameter,
  queryBoolean,
  queryInteger,
  requiredParameter,
  stringParameter,
} from '#engine/operation.ts';
import {
  decodeDirectoryRequest,
  decodeVisibility,
  localDirectoryOffset,
} from '#engine/client/directory-request.ts';
import { searchRequest } from '#engine/client/search-request.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { roomEventFilterOf } from '#engine/tenant/filters.ts';
import { membershipContent } from '#engine/client/membership-request.ts';
import { memberFilters, stateFormat } from '#engine/client/state-request.ts';

Deno.test('operation primitives preserve absence, false, zero and empty strings without coercion', () => {
  assertEquals(booleanParameter(undefined, 'x'), undefined);
  assertEquals(booleanParameter(false, 'x'), false);
  assertEquals(integerParameter(0, 'x'), 0);
  assertEquals(stringParameter('', 'x'), '');
  assertEquals(queryBoolean('false', 'x'), false);
  assertEquals(queryInteger('0', 'x'), 0);
  assertEquals(queryInteger(null, 'x'), undefined);
  assertEquals(queryBoolean(null, 'x'), undefined);
  assertEquals(enumParameter('a', 'x', ['a', 'b']), 'a');
  for (const value of [null, 1, 'true', [], {}]) {
    assertThrows(() => booleanParameter(value, 'x'));
  }
  for (
    const value of [
      null,
      false,
      '1',
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]
  ) assertThrows(() => integerParameter(value, 'x'));
  for (const value of [null, false, 1, [], {}]) {
    assertThrows(() => stringParameter(value, 'x'));
  }
  for (const value of ['true ', '1', 'TRUE', '']) {
    assertThrows(() => queryBoolean(value, 'x'));
  }
  for (const value of ['1.2', '1junk', '', 'NaN']) {
    assertThrows(() => queryInteger(value, 'x'));
  }
  for (const value of [null, [], false, 1, '']) {
    assertThrows(() => objectParameter(value, 'x'));
  }
  assertThrows(() => enumParameter('c', 'x', ['a', 'b']));
  assertThrows(() => requiredParameter(undefined, 'x'));
});

Deno.test('directory operation normalization preserves every selector and opaque remote cursor', () => {
  assertEquals(decodeDirectoryRequest(new URLSearchParams()), {
    network: { kind: 'native' },
  });
  assertEquals(
    decodeDirectoryRequest(
      new URLSearchParams(
        'limit=0&since=opaque%2Fcursor&include_all_networks=false&third_party_instance_id=network',
      ),
    ),
    {
      limit: 0,
      since: 'opaque/cursor',
      network: { kind: 'instance', id: 'network' },
    },
  );
  assertEquals(
    decodeDirectoryRequest(new URLSearchParams(), {
      limit: 1,
      since: 'remote-token',
      include_all_networks: true,
      filter: {
        generic_search_term: '',
        room_types: [null, 'm.space'],
        'org.example.extension': false,
      },
    }),
    {
      limit: 1,
      since: 'remote-token',
      network: { kind: 'all' },
      filter: {
        generic_search_term: '',
        room_types: [null, 'm.space'],
        'org.example.extension': false,
      },
    },
  );
  assertEquals(decodeVisibility({}), 'public');
  assertEquals(decodeVisibility({ visibility: 'private' }), 'private');
  assertThrows(() => decodeVisibility({ visibility: null }));
  assertEquals(localDirectoryOffset('0'), 0);
  assertThrows(() => localDirectoryOffset('opaque/cursor'));
});

Deno.test('search normalization distinguishes absence, explicit empty values and context defaults', () => {
  assertEquals(searchRequest({ search_term: '' }), {
    term: '',
    keys: ['content.body', 'content.name', 'content.topic'],
    filter: {},
    order: 'rank',
    context: undefined,
    state: false,
    groups: [],
  });
  assertEquals(
    searchRequest({
      search_term: 'needle',
      keys: [],
      filter: { limit: 1 },
      order_by: 'recent',
      event_context: {},
      include_state: true,
      groupings: { group_by: [{ key: 'sender' }, { key: 'room_id' }] },
    }),
    {
      term: 'needle',
      keys: [],
      filter: { limit: 1 },
      order: 'recent',
      context: { before: 5, after: 5, profile: false },
      state: true,
      groups: ['sender', 'room_id'],
    },
  );
  assertEquals(
    searchRequest({
      search_term: 'needle',
      event_context: { before_limit: 0, after_limit: 1, include_profile: true },
    }).context,
    { before: 0, after: 1, profile: true },
  );
  const zeroSearch = assertThrows(
    () => searchRequest({ search_term: 'needle', filter: { limit: 0 } }),
    MatrixError,
  );
  assertEquals(zeroSearch.errcode, 'M_INVALID_PARAM');
  assertEquals(roomEventFilterOf({ limit: 0 }).limit, 0);
});

Deno.test('membership and state operation decoders retain valid values and distinguish malformed fields', () => {
  assertEquals(membershipContent({}), {});
  assertEquals(membershipContent({ reason: '', extension: true }), {
    reason: '',
    extension: true,
  });
  for (const reason of [null, false, 1, []]) {
    assertThrows(() => membershipContent({ reason }));
  }
  assertEquals(stateFormat(null), 'content');
  for (const format of ['event', 'content']) {
    assertEquals(stateFormat(format), format);
  }
  assertEquals(memberFilters(new URLSearchParams()), {
    membership: undefined,
    notMembership: undefined,
  });
  for (const value of ['invite', 'join', 'knock', 'leave', 'ban'] as const) {
    assertEquals(
      memberFilters(
        new URLSearchParams({ membership: value, not_membership: value }),
      ),
      { membership: value, notMembership: value },
    );
  }
});
