// Independently scripted peer envelopes, not communico producer roundtrips.
import { assertEquals, assertRejects } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { productionFetcher } from '#engine/federation/fetcher.ts';
import {
  prepareRemoteLeave,
  sendRemoteLeave,
} from '#engine/federation/invites.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { ourKeyDocument } from '#engine/federation/keys.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
} from '#engine/signing-primitives.js';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { fetchOrNull } from '#engine/room/deps.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import type { Pdu } from '#engine/pdu.ts';
import { randomSigner } from './fixtures/signer.ts';
import { startFakeServer } from './federation/fake-server.ts';

const roomId = '!envelopes:test';
const userId = '@u:test';
const event = {
  type: 'm.room.member',
  room_id: roomId,
  sender: userId,
  state_key: userId,
  content: { membership: 'join' },
  prev_events: ['$p'],
  auth_events: ['$a'],
  depth: 2,
  origin_server_ts: 1,
  signatures: {},
  hashes: { sha256: '' },
  event_id: '$join',
} satisfies Pdu;

async function setup() {
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema, room: roomSchema } });
  const { signer, publicKey } = await randomSigner('test');
  const doc = await ourKeyDocument(
    signer,
    b64encodeStd(await exportPublicKeyRaw(publicKey)),
  );
  let answer: unknown = {};
  let v1 = false;
  const fake = await startFakeServer({
    ourKeyDoc: () => Promise.resolve(doc),
    handlers: (req) => {
      if (v1 && req.url.pathname.includes('/v2/')) {
        return Response.json({ errcode: 'M_UNRECOGNIZED' }, { status: 404 });
      }
      return Response.json(answer);
    },
  });
  const server = await store.server();
  return {
    store,
    server,
    signer,
    fake,
    fetcher: productionFetcher(server, signer, store),
    answer(value: unknown) {
      answer = value;
    },
    legacy(value = true) {
      v1 = value;
    },
    async close() {
      await fake.close();
      await store.close();
      await Deno.remove(dir, { recursive: true });
      setConfigForTests({ federation: { cacerts: [] } });
      resetCaCertsForTests();
    },
  };
}

Deno.test('peer envelopes: malformed recovery data is unavailable, not valid empty or coerced IDs', async () => {
  const h = await setup();
  try {
    for (
      const bad of [null, [], {}, { pdu_ids: [12], auth_chain_ids: [] }, {
        pdu_ids: [],
        auth_chain_ids: {},
      }]
    ) {
      h.answer(bad);
      assertEquals(await h.fetcher.stateIds(roomId, '$e', h.fake.name), null);
    }
    h.answer({ pdu_ids: [], auth_chain_ids: [], extension: true });
    assertEquals(await h.fetcher.stateIds(roomId, '$e', h.fake.name), {
      pduIds: [],
      authChainIds: [],
    });
    for (
      const bad of [{}, { pdus: [], auth_chain: {} }, {
        pdus: [null],
        auth_chain: [],
      }]
    ) {
      h.answer(bad);
      assertEquals(await h.fetcher.state(roomId, '$e', h.fake.name), null);
    }
    h.answer({ pdus: [], auth_chain: [] });
    assertEquals(await h.fetcher.state(roomId, '$e', h.fake.name), {
      state: [],
      authChain: [],
    });
  } finally {
    await h.close();
  }
});

Deno.test('peer envelopes: required lists and transaction metadata reject malformed bulk success', async () => {
  const h = await setup();
  try {
    for (
      const bad of [null, [], {}, { events: {} }, { events: [null] }, {
        events: [1],
      }]
    ) {
      h.answer(bad);
      await assertRejects(
        () => h.fetcher.missingEvents(roomId, [], [], 10, h.fake.name),
        UpstreamError,
      );
    }
    h.answer({ events: [] });
    assertEquals(
      await h.fetcher.missingEvents(roomId, [], [], 10, h.fake.name),
      [],
    );
    for (
      const bad of [{}, { pdus: [] }, {
        origin: 'remote',
        origin_server_ts: '1',
        pdus: [],
      }, { origin: 'remote', origin_server_ts: 1, pdus: [null] }]
    ) {
      h.answer(bad);
      await assertRejects(
        () => h.fetcher.backfill(roomId, [], 10, h.fake.name),
        UpstreamError,
      );
    }
    h.answer({ origin: 'remote', origin_server_ts: 1, pdus: [] });
    assertEquals(await h.fetcher.backfill(roomId, [], 10, h.fake.name), []);
  } finally {
    await h.close();
  }
});

Deno.test('peer envelopes: event, auth and timestamp schemas keep unknown extensions but never coerce', async () => {
  const h = await setup();
  try {
    for (
      const bad of [null, {}, { pdus: [event] }, {
        origin: 'remote',
        origin_server_ts: 1,
        pdus: [event, event],
      }, { origin: 'remote', origin_server_ts: 1, pdus: [null] }]
    ) {
      h.answer(bad);
      assertEquals(await h.fetcher.event('$e', h.fake.name, roomId), null);
    }
    h.answer({
      origin: 'remote',
      origin_server_ts: 1,
      pdus: [event],
      extension: true,
    });
    assertEquals(await h.fetcher.event('$e', h.fake.name, roomId), event);
    for (const bad of [{}, { auth_chain: null }, { auth_chain: [null] }]) {
      h.answer(bad);
      assertEquals(await h.fetcher.eventAuth(roomId, '$e', h.fake.name), null);
    }
    h.answer({ auth_chain: [], extension: true });
    assertEquals(await h.fetcher.eventAuth(roomId, '$e', h.fake.name), []);
    for (
      const bad of [{}, { event_id: 3, origin_server_ts: 1 }, {
        event_id: '$e',
        origin_server_ts: '1',
      }]
    ) {
      h.answer(bad);
      assertEquals(
        await h.fetcher.timestampToEvent(roomId, 1, 'f', h.fake.name),
        null,
      );
    }
    h.answer({ event_id: '$e', origin_server_ts: 1, extension: true });
    assertEquals(
      await h.fetcher.timestampToEvent(roomId, 1, 'f', h.fake.name),
      { event_id: '$e', origin_server_ts: 1 },
    );
  } finally {
    await h.close();
  }
});

Deno.test('peer envelopes: join version/template and v1 status/body are explicit', async () => {
  const h = await setup();
  try {
    for (
      const bad of [
        null,
        {},
        { event },
        { room_version: null, event },
        { room_version: 11, event },
        { room_version: '11', event: null },
        { room_version: '11', event: { ...event, depth: '2' } },
        { room_version: '11', event: { ...event, prev_events: [3] } },
      ]
    ) {
      h.answer(bad);
      await assertRejects(
        () => h.fetcher.makeJoin(roomId, userId, ['11'], h.fake.name),
        UpstreamError,
      );
    }
    h.answer({ room_version: '11', event });
    assertEquals(
      (await h.fetcher.makeJoin(roomId, userId, ['11'], h.fake.name))
        .roomVersion,
      '11',
    );
    for (
      const bad of [
        null,
        {},
        { state: [], auth_chain: null },
        { state: [null], auth_chain: [] },
        { state: [], auth_chain: [], event: null },
        { state: [], auth_chain: [], members_omitted: true },
      ]
    ) {
      h.answer(bad);
      await assertRejects(
        () => h.fetcher.sendJoin(roomId, event, h.fake.name),
        UpstreamError,
      );
    }
    h.legacy();
    for (
      const bad of [
        [],
        [200],
        ['200', { state: [], auth_chain: [] }],
        [403, { state: [], auth_chain: [] }],
        [200, null],
        [200, {}, 'extra'],
      ]
    ) {
      h.answer(bad);
      await assertRejects(
        () => h.fetcher.sendJoin(roomId, event, h.fake.name),
        UpstreamError,
      );
    }
    h.answer([200, { state: [], auth_chain: [], extension: true }]);
    assertEquals(await h.fetcher.sendJoin(roomId, event, h.fake.name), {
      state: [],
      authChain: [],
      event: undefined,
    });
  } finally {
    await h.close();
  }
});

Deno.test('peer envelopes: leave cannot invent graph/depth/version or acknowledge malformed success', async () => {
  const h = await setup();
  const invite = { roomId, userId, roomVersion: '11' };
  const deps = { server: h.server, store: h.store, signer: h.signer };
  const leave = { ...event, content: { membership: 'leave' } };
  try {
    for (
      const bad of [
        null,
        {},
        { room_version: '11', event: {} },
        { room_version: '10', event: leave },
        { room_version: '11', event: { ...leave, depth: '2' } },
        { room_version: '11', event: { ...leave, prev_events: undefined } },
      ]
    ) {
      h.answer(bad);
      await assertRejects(
        () => prepareRemoteLeave(h.fake.name, invite, deps),
        UpstreamError,
      );
    }
    h.answer({ room_version: '11', event: leave });
    assertEquals(
      (await prepareRemoteLeave(h.fake.name, invite, deps)).depth,
      2,
    );
    for (const bad of [null, [], 1]) {
      h.answer(bad);
      await assertRejects(
        () => sendRemoteLeave(h.fake.name, leave, '11', deps),
        UpstreamError,
      );
    }
    h.answer({});
    await sendRemoteLeave(h.fake.name, leave, '11', deps);
    h.legacy();
    h.answer([200, null]);
    await assertRejects(
      () => sendRemoteLeave(h.fake.name, leave, '11', deps),
      UpstreamError,
    );
    h.answer([200, {}]);
    await sendRemoteLeave(h.fake.name, leave, '11', deps);
  } finally {
    await h.close();
  }
});

Deno.test('recovery owns peer-unavailable control flow, not local fault suppression', async () => {
  const fault = new Error('synthetic local store failure');
  assertEquals(
    await assertRejects(() => fetchOrNull(() => Promise.reject(fault))),
    fault,
  );
  assertEquals(
    await fetchOrNull(() =>
      Promise.reject(new DOMException('cancelled', 'AbortError'))
    ),
    null,
  );
  const h = await setup();
  try {
    const signer = { ...h.signer, sign: () => Promise.reject(fault) };
    const fetcher = productionFetcher(h.server, signer, h.store);
    assertEquals(
      await assertRejects(() => fetcher.stateIds(roomId, '$e', h.fake.name)),
      fault,
    );
    const reason = new Error('caller cancellation');
    assertEquals(
      await fetcher.stateIds(
        roomId,
        '$e',
        h.fake.name,
        AbortSignal.abort(reason),
      ),
      null,
    );
  } finally {
    await h.close();
  }
});
