// tests/room-deps.test.ts — the injected-dependency fakes: the resolver
// verifies real signatures (and refuses tampered or expired ones), the
// fetcher answers in wire form and records its calls.
import { assert, assertEquals } from '@std/assert';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
} from './fixtures/remote.ts';

Deno.test('deps: the fake resolver verifies, refuses tampering and honors validity', async () => {
  const server = await makeRemoteServer('remote.test');
  const event = await remoteEvent('!r:test', server, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: { msgtype: 'm.text', body: 'hello' },
    prev_events: ['$prev'],
  });
  const keys = fakeKeyResolver(server);
  const good = await keys.verifyEventSignature({
    server: 'remote.test',
    keyId: 'ed25519:1',
    pdu: event,
    roomVersion: '11',
    minValidUntilMs: 0,
  });
  assert(good, 'a genuine signature verifies');
  // a tampered event (the sender — kept by the redaction keep-table —
  // changed after signing) does not
  const forged = structuredClone(event);
  forged.sender = '@mallory:remote.test';
  const bad = await keys.verifyEventSignature({
    server: 'remote.test',
    keyId: 'ed25519:1',
    pdu: forged,
    roomVersion: '11',
    minValidUntilMs: 0,
  });
  assertEquals(bad, false);
  // an unknown key id answers false
  const unknown = await keys.verifyEventSignature({
    server: 'remote.test',
    keyId: 'ed25519:2',
    pdu: event,
    roomVersion: '11',
    minValidUntilMs: 0,
  });
  assertEquals(unknown, false);
  // an expired key (validity floor after the document's valid-until)
  const stale = await makeRemoteServer('stale.test', { validUntilMs: 500 });
  const staleEvent = await remoteEvent('!r:test', stale, '11', {
    type: 'm.room.message',
    sender: '@old:stale.test',
    content: { msgtype: 'm.text', body: 'old' },
    prev_events: ['$prev'],
  });
  const staleKeys = fakeKeyResolver(stale);
  const expired = await staleKeys.verifyEventSignature({
    server: 'stale.test',
    keyId: 'ed25519:1',
    pdu: staleEvent,
    roomVersion: '11',
    minValidUntilMs: 1000,
  });
  assertEquals(expired, false);
  const within = await staleKeys.verifyEventSignature({
    server: 'stale.test',
    keyId: 'ed25519:1',
    pdu: staleEvent,
    roomVersion: '11',
    minValidUntilMs: 500,
  });
  assert(within, 'the floor at the document boundary still verifies');
});

Deno.test('deps: the fake fetcher answers in wire form and records calls', async () => {
  const server = await makeRemoteServer('remote.test');
  const event = await remoteEvent('!r:test', server, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: { msgtype: 'm.text', body: 'on the wire' },
    prev_events: ['$prev'],
  });
  const { fetcher, calls } = fakeFetcher({
    event: new Map([[String(event.event_id), event]]),
    missingEvents: [event],
  });
  const got = await fetcher.event(
    String(event.event_id),
    'remote.test',
    '!r:test',
  );
  assert(got !== null && !('event_id' in got), 'wire form carries no id');
  const missing = await fetcher.missingEvents(
    '!r:test',
    ['$a'],
    ['$b'],
    10,
    'remote.test',
  );
  assertEquals(missing.length, 1);
  assert(!('event_id' in (missing[0] as unknown as Record<string, unknown>)));
  assertEquals(calls.event, [String(event.event_id)]);
  assertEquals(calls.missingEvents, [{
    roomId: '!r:test',
    earliest: ['$a'],
    latest: ['$b'],
    limit: 10,
  }]);
});
