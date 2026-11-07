import { assert, assertEquals } from '@std/assert';
import { withAuthProofs } from '#engine/auth-proofs.ts';
import { parseOpenGraph } from '#engine/preview/og.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
  signJson,
} from '#engine/signing-primitives.js';
import { getRulebook } from '#engine/rulebook/index.ts';
import { iterativeAuthChecks } from '#engine/rulebook/state-res-v2.ts';
import { stateKeyOf } from '#engine/rulebook/types.ts';
import {
  genesisEvents,
  genesisState,
  MemStore,
  mkPdu,
  restrictedState,
  restrictedStore,
} from '#root/tests/rulebook/fixtures.ts';

Deno.test('review: unquoted OpenGraph URLs preserve slashes', () => {
  assertEquals(
    parseOpenGraph(
      '<meta property=og:image content=https://example.org/image.png>',
    )['og:image'],
    'https://example.org/image.png',
  );
});

Deno.test('review: a departed or absent user cannot authorize a restricted join', () => {
  const state = restrictedState();
  state.delete(stateKeyOf('m.room.member', '@alice:localhost'));
  const event = mkPdu({
    type: 'm.room.member',
    sender: '@new:localhost',
    content: {
      membership: 'join',
      join_authorised_via_users_server: '@alice:localhost',
    },
    signatures: { localhost: { 'ed25519:test': 'signature' } },
  }, '@new:localhost');
  assertEquals(
    getRulebook('11').checkAuthAgainstState(event, state, restrictedStore()).ok,
    false,
  );
});

Deno.test('review: public-key text is not a third-party-invite signature', () => {
  const token = mkPdu({
    type: 'm.room.third_party_invite',
    sender: '@dev:localhost',
    event_id: '$token',
    content: { public_key: 'not-a-signature' },
  }, 'token');
  const event = mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    event_id: '$invite',
    content: {
      membership: 'invite',
      third_party_invite: {
        signed: {
          mxid: '@new:localhost',
          token: 'token',
          signatures: { service: { 'ed25519:test': 'not-a-signature' } },
        },
      },
    },
  }, '@new:localhost');
  const state = genesisState();
  state.set(stateKeyOf('m.room.third_party_invite', 'token'), '$token');
  assertEquals(
    getRulebook('11').checkAuthAgainstState(
      event,
      state,
      MemStore.from([...genesisEvents(), token]),
    ).ok,
    false,
  );
});

Deno.test('review: v12 iterative auth gets the creator from the room id, not auth_events', () => {
  const create = mkPdu({
    type: 'm.room.create',
    sender: '@creator:localhost',
    room_id: undefined,
    event_id: '$create',
    content: { room_version: '12' },
  }, '');
  const member = mkPdu({
    type: 'm.room.member',
    sender: '@creator:localhost',
    room_id: '!create',
    event_id: '$join',
    content: { membership: 'join' },
  }, '@creator:localhost');
  const name = mkPdu({
    type: 'm.room.name',
    sender: '@creator:localhost',
    room_id: '!create',
    event_id: '$name',
    auth_events: ['$join'],
    content: { name: 'retained' },
  }, '');
  const state = new Map([[
    stateKeyOf('m.room.member', '@creator:localhost'),
    '$join',
  ]]);
  const resolved = iterativeAuthChecks(
    state,
    ['$name'],
    MemStore.from([create, member, name]),
    getRulebook('12').spec,
  );
  assert(resolved.get(stateKeyOf('m.room.name', '')) === '$name');
});

Deno.test('review: real third-party-invite proofs are bound to both events and used by resolution', async () => {
  const pair = await generateSigningKeypair() as CryptoKeyPair;
  const key = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
  const token = mkPdu({
    type: 'm.room.third_party_invite',
    sender: '@dev:localhost',
    event_id: '$token',
    content: { public_keys: [{ public_key: key }] },
  }, 'token');
  const signed = await signJson(
    { mxid: '@new:localhost', token: 'token' },
    'service',
    'ed25519:test',
    pair.privateKey,
  );
  const event = mkPdu({
    type: 'm.room.member',
    sender: '@dev:localhost',
    event_id: '$invite',
    content: { membership: 'invite', third_party_invite: { signed } },
  }, '@new:localhost');
  const replacement = {
    ...token,
    event_id: '$replacement',
    content: { public_key: 'bad' },
  };
  const raw = MemStore.from([...genesisEvents(), token, replacement, event]);
  const store = await withAuthProofs(raw, raw.events.values());
  const state = genesisState();
  state.set(stateKeyOf('m.room.third_party_invite', 'token'), '$token');
  const rules = getRulebook('11');
  assertEquals(rules.checkAuthAgainstState(event, state, store).ok, true);
  assertEquals(
    iterativeAuthChecks(state, ['$invite'], store, rules.spec).get(
      stateKeyOf('m.room.member', '@new:localhost'),
    ),
    '$invite',
  );
  state.set(stateKeyOf('m.room.third_party_invite', 'token'), '$replacement');
  assertEquals(rules.checkAuthAgainstState(event, state, store).ok, false);
  assertEquals(
    iterativeAuthChecks(state, ['$invite'], store, rules.spec).has(
      stateKeyOf('m.room.member', '@new:localhost'),
    ),
    false,
  );
  assertEquals(
    rules.checkAuthAgainstState(
      { ...event, event_id: '$another-member' },
      state,
      store,
    ).ok,
    false,
  );
});
