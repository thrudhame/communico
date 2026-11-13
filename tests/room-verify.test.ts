// tests/room-verify.test.ts — the one verification path (G9/G10):
// format guards, recomputed ids, unsigned strip, content-hash redaction,
// the sender-domain signature through the resolver, key validity per
// room version, and the lenient/strict size limits.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from '@std/assert';
import type { Pdu } from '#engine/pdu.ts';
import { identify, verify } from '#engine/room/verify.ts';
import { fetchBoundaryEvents } from '#engine/room/boundary-fetch.ts';
import { fakeFetcher } from './fixtures/remote.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { validatePrejoin } from '#engine/federation/prejoin.ts';
import { hashBytesOf, signWithHash } from '#tests/fixtures/hash-event.ts';
import { signJson, verifyJson } from '#engine/signing-primitives.js';
import {
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
} from './fixtures/remote.ts';

const ROOM = '!verify:test';

Deno.test('key fault ownership: prejoin create verification never filters a local key failure', async () => {
  const server = await makeRemoteServer('remote.test');
  const create = await remoteEvent(ROOM, server, '11', {
    type: 'm.room.create',
    sender: '@rudy:remote.test',
    state_key: '',
    content: { room_version: '11' },
    prev_events: [],
    auth_events: [],
  });
  const fault = new Error('prejoin key store fault');
  assertStrictEquals(
    await assertRejects(() =>
      validatePrejoin([create], ROOM, '11', {
        verifyEventSignature: () => {
          throw fault;
        },
      })
    ),
    fault,
  );
});

Deno.test('wire base64: signatures accept Matrix padding but reject URL-safe and nonzero pad bits', async () => {
  const server = await makeRemoteServer('remote.test');
  const doc = { value: 'wire-base64', signatures: {} } as Record<
    string,
    unknown
  >;
  await signJson(doc, server.name, server.keyId, server.kp.privateKey);
  const signatures = doc.signatures as Record<string, Record<string, string>>;
  const original = signatures[server.name][server.keyId];
  assert(await verifyJson(doc, server.name, server.keyId, server.kp.publicKey));
  signatures[server.name][server.keyId] = original + '==';
  assert(await verifyJson(doc, server.name, server.keyId, server.kp.publicKey));
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  signatures[server.name][server.keyId] = original.slice(0, -1) +
    alphabet[alphabet.indexOf(original.at(-1)!) + 1];
  assertEquals(
    await verifyJson(doc, server.name, server.keyId, server.kp.publicKey),
    false,
  );
  if (/[+/]/.test(original)) {
    signatures[server.name][server.keyId] = original.replaceAll('+', '-')
      .replaceAll('/', '_');
    assertEquals(
      await verifyJson(doc, server.name, server.keyId, server.kp.publicKey),
      false,
    );
  }
});

Deno.test('key fault ownership: verification and boundary retrieval preserve local resolver faults', async () => {
  const server = await makeRemoteServer('remote.test');
  const event = await msg(server, 'local-fault');
  const fault = new Error('local key store fault');
  const keys = {
    verifyEventSignature: () => {
      throw fault;
    },
  };
  assertStrictEquals(
    await assertRejects(() => verify(structuredClone(event), '11', keys)),
    fault,
  );
  const { fetcher } = fakeFetcher({
    state: new Map([[event.event_id!, { state: [event], authChain: [] }]]),
    event: new Map([[event.event_id!, event]]),
  });
  assertStrictEquals(
    await assertRejects(() =>
      fetchBoundaryEvents([event.event_id!], 1, {
        roomId: ROOM,
        at: event.event_id!,
        via: server.name,
        version: '11',
        keys,
        fetcher,
        active: () => true,
        concurrency: 1,
        read: (op) => op(),
      })
    ),
    fault,
  );
  // Peer acquisition failure remains unavailable, never admitted evidence.
  const failedKeys = {
    verifyEventSignature: () => {
      throw new UpstreamError('transport', {
        phase: 'key-doc',
        reason: 'unreachable',
      });
    },
  };
  const pack = await fetchBoundaryEvents([event.event_id!], 1, {
    roomId: ROOM,
    at: event.event_id!,
    via: server.name,
    version: '11',
    keys: failedKeys,
    fetcher,
    active: () => true,
    concurrency: 1,
    read: (op) => op(),
  });
  assertEquals(pack?.size, 0);
});

Deno.test('verify: required edge arrays and object content share the format boundary for every supported version', async () => {
  const server = await makeRemoteServer('remote.test');
  for (const version of ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12']) {
    for (
      const field of [
        'prev_events',
        'auth_events',
        'content',
        'hashes',
        'signatures',
      ]
    ) {
      const event = await msg(server, 'required', version);
      delete event.event_id;
      const raw = event as unknown as Record<string, unknown>;
      if (field === 'content') raw.content = [];
      else delete raw[field];
      await assertRejects(() => identify(event, version), Error, 'M_BAD_EVENT');
    }
    for (const value of [{}, { sha256: 2 }, []]) {
      const event = await msg(server, 'hash shape', version);
      delete event.event_id;
      (event as unknown as Record<string, unknown>).hashes = value;
      await assertRejects(() => identify(event, version), Error, 'M_BAD_EVENT');
    }
  }
});

async function msg(
  server: Awaited<ReturnType<typeof makeRemoteServer>>,
  body: string,
  version = '11',
  opts: { state_key?: string; type?: string } = {},
): Promise<Pdu> {
  return await remoteEvent(ROOM, server, version, {
    type: opts.type ?? 'm.room.message',
    sender: `@rudy:${server.name}`,
    state_key: opts.state_key,
    content: opts.type === undefined ? { msgtype: 'm.text', body } : {},
    prev_events: ['$prev'],
  });
}

Deno.test('verify: a good event verifies; unsigned is stripped from the verified form', async () => {
  const server = await makeRemoteServer('remote.test');
  const event = await msg(server, 'hello');
  (event as unknown as Record<string, unknown>).unsigned = { evil: true };
  const keys = fakeKeyResolver(server);
  const verified = await verify(event, '11', keys, { roomId: ROOM });
  assertEquals(verified.eventId, String(event.event_id));
  assertEquals(verified.oversized, false);
  assert(!('unsigned' in verified.pdu), 'unsigned never survives');
});

Deno.test('verify: format guards refuse malformed events before storage', async () => {
  const server = await makeRemoteServer('remote.test');
  const keys = fakeKeyResolver(server);
  const base = () => msg(server, 'x');
  // missing required fields
  const noSender = await base();
  delete (noSender as unknown as Record<string, unknown>).sender;
  await assertRejects(() => verify(noSender, '11', keys), Error, 'M_BAD_EVENT');
  // >20 prev_events
  const manyPrevs = await base();
  manyPrevs.prev_events = Array.from({ length: 21 }, (_, i) => `$p${i}`);
  await assertRejects(
    () => verify(manyPrevs, '11', keys),
    Error,
    'M_TOO_MANY_PREV_EVENTS',
  );
  // >10 auth_events
  const manyAuth = await base();
  manyAuth.auth_events = Array.from({ length: 11 }, (_, i) => `$a${i}`);
  await assertRejects(
    () => verify(manyAuth, '11', keys),
    Error,
    'M_TOO_MANY_AUTH_EVENTS',
  );
  // room_id required before v12
  const noRoom = await base();
  delete (noRoom as unknown as Record<string, unknown>).room_id;
  await assertRejects(() => verify(noRoom, '11', keys), Error, 'room_id');
  // depth bound
  const deep = await base();
  deep.depth = 2 ** 53;
  await assertRejects(() => verify(deep, '11', keys), Error, 'depth');
  // non-string state_key
  const badKey = await msg(server, 'x', '11', {
    state_key: 'k',
    type: 'm.room.topic',
  });
  (badKey as unknown as Record<string, unknown>).state_key = 42;
  await assertRejects(() => verify(badKey, '11', keys), Error, 'state_key');
  for (const field of ['prev_events', 'auth_events']) {
    for (
      const value of [null, 'not an array', [null], [{}], [['$legacy', {}]]]
    ) {
      const malformed = await base();
      (malformed as unknown as Record<string, unknown>)[field] = value;
      await assertRejects(
        () => verify(malformed, '11', keys),
        Error,
        'must be string arrays',
      );
    }
  }
});

Deno.test('verify: the event id is recomputed, never trusted; uncanonicalizable content drops', async () => {
  const server = await makeRemoteServer('remote.test');
  const keys = fakeKeyResolver(server);
  const tampered = await msg(server, 'x');
  tampered.event_id = '$wrong';
  await assertRejects(
    () => verify(tampered, '11', keys),
    Error,
    'does not recompute',
  );
  // a float in content cannot canonicalize (the BadJSON shape)
  const bad = await msg(server, 'x');
  bad.content.score = 1.5;
  await assertRejects(() => verify(bad, '11', keys), Error, 'M_BAD_EVENT');
  // the wire form (no event_id) is fine — the id is computed
  const wire = await msg(server, 'x');
  delete (wire as unknown as Record<string, unknown>).event_id;
  const verified = await verify(wire, '11', keys, { roomId: ROOM });
  assert(verified.eventId.startsWith('$'));
});

Deno.test('hash wire: padded content hashes compare bytes and retain signed content for every supported version', async () => {
  const server = await makeRemoteServer('remote.test');
  const keys = fakeKeyResolver(server);
  for (const version of ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12']) {
    const base = await msg(server, 'intact padded body', version);
    const hash = await hashBytesOf(base);
    assertEquals(hash.length, 44);
    const event = await signWithHash(base, server, version, hash);
    const signatures = structuredClone(event.signatures);
    const verified = await verify(event, version, keys, { roomId: ROOM });
    assertEquals(verified.pdu.content.body, 'intact padded body');
    assertEquals(
      verified.pdu.hashes.sha256,
      hash,
      'must not normalize the signed representation',
    );
    assertEquals(verified.pdu.signatures, signatures);
  }
});

Deno.test('hash wire: malformed alphabet, padding, pad bits and digest length are validation failures', async (t) => {
  const server = await makeRemoteServer('remote.test');
  const base = await msg(server, 'not published');
  for (
    const hash of [
      '_'.repeat(43),
      'A'.repeat(43) + '==',
      'A'.repeat(42) + 'B',
      'AA',
      '',
      'A'.repeat(44),
      'A'.repeat(43) + ' ',
    ]
  ) {
    await t.step('hash:' + JSON.stringify(hash), async () => {
      const event = await signWithHash(base, server, '11', hash);
      const error = await assertRejects(
        () => verify(event, '11', fakeKeyResolver(server)),
        UpstreamError,
      );
      assertEquals(error.category, 'validation');
    });
  }
});

Deno.test('verify: a content-hash mismatch stores the redacted copy we calculated', async () => {
  const server = await makeRemoteServer('remote.test');
  const keys = fakeKeyResolver(server);
  const tampered = await msg(server, 'original');
  tampered.content.body = 'tampered'; // the hash no longer matches
  const verified = await verify(tampered, '11', keys, { roomId: ROOM });
  const stored = JSON.stringify(verified.pdu);
  assert(!stored.includes('tampered'), stored);
  assert(!stored.includes('original'), stored);
  // the event id still recomputes to the signed one
  assertEquals(verified.eventId, String(tampered.event_id));
});

Deno.test('verify: a bad signature or the wrong sender domain is refused before storage', async () => {
  const server = await makeRemoteServer('remote.test');
  const keys = fakeKeyResolver(server);
  // garbage signature value
  const badSig = await msg(server, 'x');
  (badSig.signatures as Record<string, Record<string, string>>)[
    'remote.test'
  ]['ed25519:1'] = 'AAAA';
  await assertRejects(
    () => verify(badSig, '11', keys),
    Error,
    'M_UNAUTHORIZED',
  );
  // signed by another server than the sender's domain (the victim
  // sender from the start — the reference hash covers it)
  const other = await makeRemoteServer('other.test');
  const forged = await remoteEvent(ROOM, other, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: { msgtype: 'm.text', body: 'wrong signer' },
    prev_events: ['$prev'],
  });
  const allKeys = fakeKeyResolver(server, other);
  await assertRejects(
    () => verify(forged, '11', allKeys),
    Error,
    'M_UNAUTHORIZED',
  );
  // no key anywhere for the sender's domain
  const stranger = await makeRemoteServer('stranger.test');
  const noKey = await msg(stranger, 'x');
  await assertRejects(
    () => verify(noKey, '11', fakeKeyResolver(server)),
    Error,
    'M_UNAUTHORIZED',
  );
});

Deno.test('verify: key validity is enforced per room version', async () => {
  const stale = await makeRemoteServer('stale.test', { validUntilMs: 500 });
  const keys = fakeKeyResolver(stale);
  // v11 enforces key validity at the event's origin_server_ts: a document
  // valid only before it fails
  const old = await remoteEvent(ROOM, stale, '11', {
    type: 'm.room.message',
    sender: '@old:stale.test',
    content: { msgtype: 'm.text', body: 'expired key' },
    prev_events: ['$prev'],
    origin_server_ts: 1000,
  });
  await assertRejects(() => verify(old, '11', keys), Error, 'M_UNAUTHORIZED');
  // v4 has no validity rule: the same key verifies
  const v4 = await remoteEvent(ROOM, stale, '4', {
    type: 'm.room.message',
    sender: '@old:stale.test',
    content: { msgtype: 'm.text', body: 'v4 lenient' },
    prev_events: ['$prev'],
    origin_server_ts: 1000,
  });
  const verified = await verify(v4, '4', keys, { roomId: ROOM });
  assert(verified.eventId.startsWith('$'));
});

Deno.test('verify: size limits — bytes (v11+) vs codepoints (≤ v10); oversized comes back, never dropped', async () => {
  const server = await makeRemoteServer('size.test');
  const keys = fakeKeyResolver(server);
  const bigKey = '💥'.repeat(70); // 280 bytes, 70 codepoints
  // strict version: dropped
  const dropped = await msg(server, 'x', '11', {
    state_key: bigKey,
    type: 'my.room.breaker',
  });
  await assertRejects(() => verify(dropped, '11', keys), Error, '255 bytes');
  // lenient version: the same key passes (codepoints)
  const lenient = await msg(server, 'x', '10', {
    state_key: bigKey,
    type: 'my.room.breaker',
  });
  const ok = await verify(lenient, '10', keys, { roomId: ROOM });
  assertEquals(ok.oversized, false);
  // and a >255-CODEPOINT key in the lenient version comes back oversized
  const hugeKey = '💥'.repeat(300);
  const huge = await msg(server, 'x', '10', {
    state_key: hugeKey,
    type: 'my.room.breaker',
  });
  const flagged = await verify(huge, '10', keys, { roomId: ROOM });
  assertEquals(flagged.oversized, true);
});

Deno.test('verify: a v12 create must match the room context it names', async () => {
  const server = await makeRemoteServer('remote.test');
  const keys = fakeKeyResolver(server);
  const create = await remoteEvent('!whatever:remote.test', server, '12', {
    type: 'm.room.create',
    sender: '@rudy:remote.test',
    state_key: '',
    content: { room_version: '12' },
    prev_events: [],
    omitRoomId: true,
  });
  const rightRoom = '!' + String(create.event_id).slice(1);
  const ok = await verify(create, '12', keys, { roomId: rightRoom });
  assertEquals(ok.eventId, String(create.event_id));
  await assertRejects(
    () => verify(create, '12', keys, { roomId: '!elsewhere:test' }),
    Error,
    'E_ROOM_ID_MISMATCH',
  );
});

Deno.test('verify: identify alone answers the id and the size verdict', async () => {
  const server = await makeRemoteServer('remote.test');
  const event = await msg(server, 'x');
  const pre = await identify(event, '11', { roomId: ROOM });
  assertEquals(pre.eventId, String(event.event_id));
  assertEquals(pre.oversized, false);
});

Deno.test('verify: required authorizer signatures are cryptographic, versioned and independent of snapshot fallback', async () => {
  const sender = await makeRemoteServer('sender.test');
  const authorizer = await makeRemoteServer('authorizer.test');
  const keys = fakeKeyResolver(sender, authorizer);
  const { countersign } = await import('#engine/federation/invites.ts');
  const { b64encodeStd } = await import('#engine/signing-primitives.js');
  const { redact } = await import('#engine/eventid.ts');
  const signer = {
    serverName: authorizer.name,
    keyId: authorizer.keyId,
    sign: async (value: string) =>
      b64encodeStd(
        new Uint8Array(
          await crypto.subtle.sign(
            'Ed25519',
            authorizer.kp.privateKey,
            new TextEncoder().encode(value),
          ),
        ),
      ),
  };
  for (const version of ['8', '9', '10', '11', '12']) {
    const event = await remoteEvent(ROOM, sender, version, {
      type: 'm.room.member',
      sender: '@joiner:sender.test',
      state_key: '@joiner:sender.test',
      content: {
        membership: 'join',
        join_authorised_via_users_server: '@admin:authorizer.test',
      },
      prev_events: ['$prev'],
    });
    event.signatures[authorizer.name] = { [authorizer.keyId]: 'forged' };
    await assertRejects(
      () => verify(structuredClone(event), version, keys),
      Error,
      'authorising',
    );
    await assertRejects(
      () =>
        verify(structuredClone(event), version, keys, {
          localSnapshotFallback: { self: sender.name, resident: sender.name },
        }),
      Error,
      'authorising',
    );
    const redacted = redact(
      event as unknown as Record<string, unknown>,
      version,
    ) as unknown as Pdu;
    if (version === '8') {
      assertEquals(
        (await verify(redacted, version, keys)).pdu.content
          .join_authorised_via_users_server,
        undefined,
      );
    } else {
      await assertRejects(
        () => verify(redacted, version, keys),
        Error,
        'authorising',
      );
    }
    await countersign(event, version, signer);
    event.signatures['unrelated.test'] = { 'ed25519:bad': 'invalid' };
    assertEquals(
      (await verify(structuredClone(event), version, keys)).eventId,
      event.event_id,
    );
    const expired = fakeKeyResolver(sender, { ...authorizer, validUntilMs: 0 });
    await assertRejects(
      () => verify(structuredClone(event), version, expired),
      Error,
      'authorising',
    );
  }
  for (const via of [null, 42, '', 'not-a-user', '@missing:']) {
    const malformed = await remoteEvent(ROOM, sender, '11', {
      type: 'm.room.member',
      sender: '@joiner:sender.test',
      state_key: '@joiner:sender.test',
      content: { membership: 'join', join_authorised_via_users_server: via },
      prev_events: ['$prev'],
    });
    await assertRejects(
      () => verify(malformed, '11', keys),
      Error,
      'malformed authorising',
    );
  }
});
