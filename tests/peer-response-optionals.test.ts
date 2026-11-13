import { assertEquals, assertThrows } from '@std/assert';
import { config } from '#engine/config.ts';
import { remoteDirectoryResponse } from '#engine/client/directory-response.ts';
import {
  membershipTemplate,
  sendJoinResponse,
  sendVerdicts,
  stateResponse,
} from '#engine/federation/responses.ts';
import {
  directoryResponse,
  profileResponse,
  roomSummaryResponse,
} from '#engine/federation/discovery-response.ts';
import { keyDocument, oldKeysOf } from '#engine/federation/key-document.ts';
import { publicDeviceKey, remoteDeviceSnapshot } from '#engine/e2ee-remote.ts';
import { publicSigning } from '#engine/e2ee-public-signing.ts';
import { decodeSigningKey } from '#engine/e2ee-signing.ts';
import { claimedKey } from '#engine/e2ee-wire.ts';
import { optionalField, stringOf } from '#engine/net/json.ts';

const user = '@q:peer.test';
const publicKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const device = () => ({
  user_id: user,
  device_id: 'D',
  algorithms: [],
  keys: { 'ed25519:D': publicKey },
  signatures: {},
});
const event = () => ({
  type: 'm.room.member',
  room_id: '!q:peer.test',
  sender: user,
  state_key: user,
  content: { membership: 'join', 'org.example.opaque': null },
  prev_events: [],
  auth_events: [],
  depth: 1,
  origin_server_ts: 1,
  hashes: { sha256: publicKey },
  signatures: {},
});

Deno.test('optional peer helper preserves meaningful null only by explicit schema declaration', () => {
  assertEquals(optionalField(null, stringOf), undefined);
  assertEquals(optionalField(undefined, stringOf), undefined);
  assertEquals(optionalField('', stringOf), '');
  assertThrows(() => optionalField(1, stringOf));
  assertEquals(optionalField(null, (raw) => raw, { nullIsValue: true }), null);
});

Deno.test('optional peer fields: recorded tuwunel null page tokens become absent, never client nulls', async () => {
  const bytes = await Deno.readFile(
    'tests/fixtures/peer-responses/tuwunel-public-rooms.json.bin',
  );
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  assertEquals(
    digest,
    'a39fdb3e66e31da9ea3ad46ee70fe05115c95c2d786291d4081ddee321691954',
  );
  const raw = JSON.parse(new TextDecoder().decode(bytes));
  assertEquals([raw.next_batch, raw.prev_batch], [null, null]);
  const before = JSON.stringify(raw);
  const page = remoteDirectoryResponse(raw);
  assertEquals('next_batch' in page, false);
  assertEquals('prev_batch' in page, false);
  assertEquals(page.chunk, raw.chunk);
  assertEquals(JSON.stringify(raw), before);
  for (const token of [1, false, [], {}]) {
    assertThrows(() =>
      remoteDirectoryResponse({ chunk: [], next_batch: token })
    );
  }
  assertThrows(() => remoteDirectoryResponse({ chunk: null }));
  assertEquals(
    remoteDirectoryResponse({ chunk: [], 'org.example.opaque': null }),
    { chunk: [], 'org.example.opaque': null },
  );
});

Deno.test('optional peer fields: membership and send envelopes keep required fields and opaque events intact', () => {
  const pdu = event();
  assertEquals(
    membershipTemplate({ room_version: null, event: pdu }, 'make-join', ['1']),
    { roomVersion: '1', event: pdu },
  );
  assertEquals(
    sendJoinResponse({
      state: [pdu],
      auth_chain: [],
      event: null,
      members_omitted: null,
      servers_in_room: null,
    }),
    { state: [pdu], authChain: [], event: undefined },
  );
  assertEquals(pdu.content['org.example.opaque'], null);
  for (const value of [1, '', [], {}]) {
    assertThrows(() =>
      sendJoinResponse({ state: [], auth_chain: [], members_omitted: value })
    );
  }
  assertThrows(() => sendJoinResponse({ state: null, auth_chain: [] }));
  assertThrows(() => stateResponse({ pdus: [], auth_chain: null }));
  assertThrows(() =>
    membershipTemplate({ room_version: '1', event: null }, 'make-join', ['1'])
  );
  const raw = { pdus: { '$q': { error: null, 'org.example.opaque': null } } };
  assertEquals<unknown>(sendVerdicts(raw), {
    '$q': { 'org.example.opaque': null },
  });
  assertEquals(raw.pdus.$q.error, null);
  assertThrows(() => sendVerdicts({ pdus: { '$q': { error: 2 } } }));
  assertThrows(() => sendVerdicts({ pdus: null }));
});

Deno.test('optional peer fields: discovery projections omit null known optionals but preserve meaningful profile nulls', () => {
  const required = {
    room_id: '!q:peer.test',
    num_joined_members: 1,
    world_readable: false,
    guest_can_join: false,
  };
  assertEquals(
    roomSummaryResponse({
      ...required,
      name: null,
      join_rule: null,
      allowed_room_ids: null,
    }),
    required,
  );
  assertThrows(() => roomSummaryResponse({ ...required, name: 1 }));
  assertThrows(() =>
    roomSummaryResponse({ ...required, world_readable: null })
  );
  assertThrows(() =>
    directoryResponse({ room_id: '!q:peer.test', servers: null })
  );
  assertEquals(
    profileResponse({
      displayname: null,
      avatar_url: null,
      'org.example.null': null,
    }),
    { 'org.example.null': null },
  );
  assertThrows(() => profileResponse({ displayname: false }));
});

Deno.test('optional peer fields: server key defaults never rewrite signed documents', () => {
  const raw = {
    server_name: 'peer.test',
    valid_until_ts: 1,
    verify_keys: {},
    old_verify_keys: null,
    signatures: {},
    'org.example.opaque': null,
  };
  const before = JSON.stringify(raw);
  const parsed = keyDocument(raw);
  assertEquals(oldKeysOf(parsed), {});
  assertEquals(JSON.stringify(parsed), before);
  for (const value of [false, [], 1, '']) {
    assertThrows(() => keyDocument({ ...raw, old_verify_keys: value }));
  }
  assertThrows(() => keyDocument({ ...raw, verify_keys: null }));
});

Deno.test('optional peer fields: remote E2EE device, snapshot, signing and claim families share absence semantics', () => {
  const limits = config().e2ee;
  assertEquals(
    'unsigned' in
      publicDeviceKey({ ...device(), unsigned: null }, user, 'D', limits),
    false,
  );
  assertEquals(
    publicDeviceKey(
      { ...device(), unsigned: { device_display_name: null } },
      user,
      'D',
      limits,
    ).unsigned,
    {},
  );
  const snapshot = remoteDeviceSnapshot(
    {
      user_id: user,
      stream_id: 1,
      devices: [{ device_id: 'D', device_display_name: null, keys: device() }],
      master_key: null,
      self_signing_key: null,
    },
    user,
    limits,
  );
  assertEquals(snapshot.signing, {});
  assertEquals(snapshot.devices[0].key!.unsigned, {});
  assertEquals(
    publicSigning({ master_key: null, self_signing_key: null }, user, limits),
    {},
  );
  const signing = {
    user_id: user,
    usage: ['master'],
    keys: { ['ed25519:' + publicKey]: publicKey },
    signatures: null,
  };
  assertEquals(
    JSON.parse(decodeSigningKey(signing, user, 'master', limits).json),
    signing,
  );
  const claim = { key: publicKey, signatures: {}, fallback: null };
  claimedKey(claim, 'signed_curve25519', limits);
  assertEquals(claim.fallback, null, 'signed claim bytes are retained');
  for (const value of [false, 1, 'wrong', []]) {
    assertThrows(() =>
      publicDeviceKey({ ...device(), unsigned: value }, user, 'D', limits)
    );
    assertThrows(() => publicSigning({ master_key: value }, user, limits));
  }
  assertThrows(() =>
    remoteDeviceSnapshot(
      {
        user_id: user,
        stream_id: 1,
        devices: [{ device_id: 'D', keys: null }],
      },
      user,
      limits,
    )
  );
  assertThrows(() =>
    publicDeviceKey({ ...device(), signatures: null }, user, 'D', limits)
  );
  assertThrows(() =>
    claimedKey({ ...claim, fallback: 1 }, 'signed_curve25519', limits)
  );
});
