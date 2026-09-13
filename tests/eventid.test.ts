import {
  assert,
  assertEquals,
  assertNotEquals,
} from '@std/assert';
import { eventIdFor, redact } from '#engine/eventid.ts';
import {
  b64decode,
  contentHashOf,
  importPrivateKeyFromSeed,
  signJson,
} from '#engine/signing-primitives.js';

const PDU = {
  type: 'm.room.message',
  room_id: '!r:localhost',
  sender: '@dev:localhost',
  content: { body: 'hello', msgtype: 'm.text' },
  prev_events: ['$abc'],
  auth_events: [],
  origin_server_ts: 1000,
  depth: 4,
  hashes: { sha256: 'placeholder' },
};

Deno.test('eventIdFor: shape is $ + 43 base64url chars', async () => {
  const id = await eventIdFor(PDU, '11');
  assert(/^\$[A-Za-z0-9_-]{43}$/.test(id), `bad shape: ${id}`);
});

Deno.test('eventIdFor: deterministic', async () => {
  assertEquals(await eventIdFor(PDU, '11'), await eventIdFor({ ...PDU }, '11'));
});

Deno.test('eventIdFor: redacted content does not change the ID', async () => {
  const other = await eventIdFor({
    ...PDU,
    content: { body: 'completely different', msgtype: 'm.image' },
  }, '11');
  assertEquals(await eventIdFor(PDU, '11'), other);
});

Deno.test('eventIdFor: sender changes the ID', async () => {
  const other = await eventIdFor({ ...PDU, sender: '@other:localhost' }, '11');
  assertNotEquals(await eventIdFor(PDU, '11'), other);
});

Deno.test('eventIdFor: hashes are covered (KEPT in the reference hash)', async () => {
  const other = await eventIdFor({
    ...PDU,
    hashes: { sha256: 'differenthashvalue00000000000000000000000' },
  }, '11');
  assertNotEquals(await eventIdFor(PDU, '11'), other);
});

Deno.test('eventIdFor: unknown room version throws', async () => {
  let threw = false;
  try {
    await eventIdFor(PDU, '10');
  } catch (e) {
    threw = String(e).includes('M_UNSUPPORTED_ROOM_VERSION');
  }
  assert(threw, 'expected M_UNSUPPORTED_ROOM_VERSION');
});

Deno.test('redact: m.room.member keeps membership + join_authorised, trims third_party_invite to signed', () => {
  const r = redact({
    type: 'm.room.member',
    sender: '@a:b',
    state_key: '@c:d',
    content: {
      membership: 'join',
      displayname: 'X',
      avatar_url: 'mxc://y',
      third_party_invite: { display_name: 'Z', signed: { mxid: '@c:d', token: 't' } },
    },
  }, '11');
  assertEquals(r.content, {
    membership: 'join',
    third_party_invite: { signed: { mxid: '@c:d', token: 't' } },
  });
});

Deno.test('redact: m.room.create keeps content unchanged (no creator in v11)', () => {
  const content = { room_version: '11', extra: true };
  const r = redact({ type: 'm.room.create', sender: '@a:b', content }, '11');
  assertEquals(r.content, content);
});

Deno.test('redact: m.room.power_levels keeps the v11 set — NOT notifications (R9)', () => {
  const r = redact({
    type: 'm.room.power_levels',
    content: {
      ban: 50, invite: 0, notifications: { room: 100 },
      users: { '@a:b': 100 }, custom: 1,
    },
  }, '11');
  assertEquals(r.content, {
    ban: 50, invite: 0, users: { '@a:b': 100 },
  });
});

Deno.test('redact: m.room.join_rules keeps join_rule + allow', () => {
  const r = redact({
    type: 'm.room.join_rules',
    content: { join_rule: 'invite', allow: [], extra: 1 },
  }, '11');
  assertEquals(r.content, { join_rule: 'invite', allow: [] });
});

Deno.test('redact: m.room.redaction keeps redacts under content (v11)', () => {
  const r = redact({
    type: 'm.room.redaction',
    content: { redacts: '$x', reason: 'spam' },
  }, '11');
  assertEquals(r.content, { redacts: '$x' });
});

Deno.test('redact: drops non-v11 top-level keys (origin, membership, prev_state)', () => {
  const r = redact({
    type: 'm.room.message', room_id: '!r:x', sender: '@a:b',
    origin: 'x.org', membership: 'join', prev_state: [],
    content: { body: 'hi' },
  }, '11');
  assert(!('origin' in r), 'origin must be stripped in v11');
  assert(!('membership' in r), 'top-level membership must be stripped');
  assert(!('prev_state' in r), 'prev_state must be stripped');
});

// Spec appendix "Cryptographic Test Vectors" (v1.11 appendices):
// SIGNING_KEY_SEED / serverName()="domain" / KEY_ID="ed25519:1".
const SEED_B64 = 'YJDBA9Xnr2sVqXD9Vj7XVUnmFZcZrlw8Md7kMW+3XA1';

Deno.test('spec vectors: JSON signing of {} and {one,two}', async () => {
  const priv = await importPrivateKeyFromSeed(b64decode(SEED_B64));
  const empty: Record<string, unknown> = {};
  await signJson(empty, 'domain', 'ed25519:1', priv);
  assertEquals(
    (empty.signatures as Record<string, Record<string, string>>).domain['ed25519:1'],
    'K8280/U9SSy9IVtjBuVeLr+HpOB4BQFWbg+UZaADMtTdGYI7Geitb76LTrr5QV/7Xg4ahLwYGYZzuHGZKM5ZAQ',
  );
  const two: Record<string, unknown> = { one: 1, two: 'Two' };
  await signJson(two, 'domain', 'ed25519:1', priv);
  assertEquals(
    (two.signatures as Record<string, Record<string, string>>).domain['ed25519:1'],
    'KqmLSbO39/Bzb0QIYE82zqLwsA+PDzYIpIRA2sRQ4sL53+sN6/fpNSoqE7BP7vBZhG6kYdD13EIMJpvhJI+6Bw',
  );
});

Deno.test('spec vectors: event content hashes', async () => {
  const minimal = {
    room_id: '!x:domain', sender: '@a:domain', origin: 'domain',
    origin_server_ts: 1000000, signatures: {}, hashes: {}, type: 'X',
    content: {}, prev_events: [], auth_events: [], depth: 3,
    unsigned: { age_ts: 1000000 },
  };
  assertEquals(
    await contentHashOf(minimal),
    '5jM4wQpv6lnBo7CLIghJuHdW+s2CMBJPUOGOC89ncos',
  );
  const message = {
    content: { body: 'Here is the message content' },
    event_id: '$0:domain', origin: 'domain', origin_server_ts: 1000000,
    type: 'm.room.message', room_id: '!r:domain', sender: '@u:domain',
    signatures: {}, unsigned: { age_ts: 1000000 },
  };
  assertEquals(
    await contentHashOf(message),
    'onLKD1bGljeBWQhWZ1kaP9SorVmRQNdN5aM2JYU2n/g',
  );
});

Deno.test('spec vectors: redacted message event signature reproduces', async () => {
  // The appendix's message event was signed under pre-v11 rules, whose
  // stripped form KEEPS `origin` (v1.11 rooms v11 § Redactions: origin /
  // membership / prev_state "are no longer protected"). Our v11 pipeline
  // must therefore NOT reproduce it — but the SAME bytes with origin
  // kept must, proving the canonical + sign pipeline is byte-exact with
  // the spec and isolating v11's delta to the origin strip.
  const hash = 'onLKD1bGljeBWQhWZ1kaP9SorVmRQNdN5aM2JYU2n/g';
  const expected =
    'Wm+VzmOUOz08Ds+0NTWb1d4CZrVsJSikkeRxh6aCcUwu6pNC78FunoD7KNWzqFn241eYHYMGCA5McEiVPdhzBA';
  const priv = await importPrivateKeyFromSeed(b64decode(SEED_B64));
  const legacyStripped: Record<string, unknown> = {
    content: {},
    event_id: '$0:domain',
    origin: 'domain',
    origin_server_ts: 1000000,
    type: 'm.room.message',
    room_id: '!r:domain',
    sender: '@u:domain',
    hashes: { sha256: hash },
  };
  await signJson(legacyStripped, 'domain', 'ed25519:1', priv);
  assertEquals(
    (legacyStripped.signatures as Record<string, Record<string, string>>)
      .domain['ed25519:1'],
    expected,
  );
  // ...while the v11-redacted form (origin stripped) signs differently.
  const message: Record<string, unknown> = {
    content: { body: 'Here is the message content' },
    event_id: '$0:domain',
    origin: 'domain',
    origin_server_ts: 1000000,
    type: 'm.room.message',
    room_id: '!r:domain',
    sender: '@u:domain',
    signatures: {},
    unsigned: { age_ts: 1000000 },
    hashes: { sha256: hash },
  };
  const redacted = redact(message, '11');
  assert(!('origin' in redacted), 'v11 strips origin');
  await signJson(redacted, 'domain', 'ed25519:1', priv);
  assertNotEquals(
    (redacted.signatures as Record<string, Record<string, string>>)
      .domain['ed25519:1'],
    expected,
  );
});
