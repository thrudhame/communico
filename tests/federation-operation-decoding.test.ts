import { assertEquals, assertThrows } from '@std/assert';
import {
  backfillRequest,
  missingEventsRequest,
} from '#engine/federation/history-request.ts';
import {
  notaryGetFloor,
  notaryRequests,
} from '#engine/federation/notary-request.ts';
import { transactionRequest } from '#engine/federation/transaction-request.ts';

Deno.test('federation history decoding preserves repeated roots and explicit zeros', () => {
  assertEquals(backfillRequest(new URLSearchParams('v=a&v=b&limit=0')), {
    v: ['a', 'b'],
    limit: 0,
  });
  assertEquals(
    missingEventsRequest({ earliest_events: [], latest_events: ['a'] }),
    { earliest: [], latest: ['a'], limit: 10, minDepth: 0 },
  );
  assertEquals(
    missingEventsRequest({
      earliest_events: ['a'],
      latest_events: ['b'],
      limit: 0,
      min_depth: 5,
    }),
    { earliest: ['a'], latest: ['b'], limit: 0, minDepth: 5 },
  );
  for (const query of ['', 'limit=1', 'v=a&limit=', 'v=a&limit=1.5']) {
    assertThrows(() => backfillRequest(new URLSearchParams(query)));
  }
});
Deno.test('notary decoding evaluates every criterion with one current-time default', () => {
  assertEquals(notaryGetFloor(new URLSearchParams(), 100), 100);
  assertEquals(
    notaryGetFloor(new URLSearchParams('minimum_valid_until_ts=0'), 100),
    0,
  );
  assertEquals(
    notaryRequests({
      server_keys: {
        a: {},
        b: { key: {} },
        c: {
          old: { minimum_valid_until_ts: 0 },
          next: { minimum_valid_until_ts: 200 },
        },
      },
    }, 100),
    [{ server: 'a', minimum: 100 }, { server: 'b', minimum: 100 }, {
      server: 'c',
      minimum: 200,
    }],
  );
});
Deno.test('transaction envelope validates its required timestamp even though it does not alter event order', () => {
  assertEquals(
    transactionRequest({
      origin: 'a',
      origin_server_ts: 0,
      pdus: [],
      extension: true,
    }, 'a'),
    { timestamp: 0, pdus: [], edus: [] },
  );
  for (const pdus of [null, {}, [null], [1]]) {
    assertThrows(() =>
      transactionRequest({ origin: 'a', origin_server_ts: 0, pdus }, 'a')
    );
  }
});
