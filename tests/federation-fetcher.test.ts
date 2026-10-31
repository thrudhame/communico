// tests/federation-fetcher.test.ts — the production Fetcher and
// KeyResolver against in-process fake peers (real TLS, fixture CA, test
// keys): the missing-events chase, the /state_ids + /event gap-tip pack,
// backfill into the history segment, make_join/send_join payloads, all
// feeding the 3c functions (ingestRemote, backfill, joinRemote); the key
// resolver verifies a fake peer's signed PDU and refuses a wrong key /
// unknown key id / expired document. No external network, no counterpart
// servers.
import { assert, assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { RemoteDeps } from '#engine/room/deps.ts';
import { backfill } from '#engine/room/history.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { joinRemote } from '#engine/room/join.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import type { Signer } from '#engine/room/signer.ts';
import { productionFetcher } from '#engine/federation/fetcher.ts';
import { productionKeyResolver } from '#engine/federation/keyresolver.ts';
import { ourKeyDocument } from '#engine/federation/keys.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import type { Db } from '#engine/store/db.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
} from '#engine/signing-primitives.js';
import {
  makeRemoteServer,
  remoteEvent,
  type RemoteServer,
  wireOf,
} from './fixtures/remote.ts';
import { type Genesis, genesis } from './fixtures/genesis.ts';
import { testRemoteServer, testSigner } from './fixtures/signer.ts';
import { makeDoc } from './federation/doc-helper.ts';
import { fakeMessage, makeFakeRoom } from './fixtures/remote-room.ts';
import { type FakeServer, startFakeServer } from './federation/fake-server.ts';

installServerHooks();

type FakeRoom = Awaited<ReturnType<typeof makeFakeRoom>>;

async function withStore(
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(
    {
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    },
    { schemas: { room: roomSchema, server: serverSchema } },
  );
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

// The scripted room endpoints the fake serves (per-test answers, wire
// form out) plus the recording of the request shapes the fetcher sends.
// The room model arrives after the fake starts (the fake's own identity
// signs its events), so it rides a holder consulted per request.
type Scripted = {
  missingAnswers: Pdu[];
  stateIds: Map<string, { pdu_ids: string[]; auth_chain_ids: string[] }>;
  events: Map<string, Pdu | null>;
  authChains: Map<string, Pdu[]>;
  missingBodies: Record<string, unknown>[];
  backfillQueries: { from: string[]; limit: number }[];
  fr?: FakeRoom;
};

function newScripted(): Scripted {
  return {
    missingAnswers: [],
    stateIds: new Map(),
    events: new Map(),
    authChains: new Map(),
    missingBodies: [],
    backfillQueries: [],
  };
}

function handlersOf(s: Scripted) {
  return (req: {
    method: string;
    url: URL;
    json(): unknown;
  }): Response | Promise<Response> | null => {
    const path = req.url.pathname;
    if (path.startsWith('/_matrix/federation/v1/get_missing_events/')) {
      s.missingBodies.push(req.json() as Record<string, unknown>);
      return Response.json({ events: s.missingAnswers.map(wireOf) });
    }
    if (path.startsWith('/_matrix/federation/v1/state_ids/')) {
      const at = req.url.searchParams.get('event_id') ?? '';
      const scripted = s.stateIds.get(at);
      if (scripted !== undefined) return Response.json(scripted);
      const fromRoom = s.fr !== undefined ? s.fr.stateIdsAt(at) : null;
      return Response.json(
        fromRoom === null ? { pdu_ids: [], auth_chain_ids: [] } : {
          pdu_ids: fromRoom.pduIds,
          auth_chain_ids: fromRoom.authChainIds,
        },
      );
    }
    if (path.startsWith('/_matrix/federation/v1/event_auth/')) {
      const id = decodeURIComponent(path.split('/').pop()!);
      return Response.json({
        auth_chain: (s.authChains.get(id) ?? []).map(wireOf),
      });
    }
    if (path.startsWith('/_matrix/federation/v1/event/')) {
      const id = decodeURIComponent(
        path.slice('/_matrix/federation/v1/event/'.length),
      );
      const scripted = s.events.get(id);
      const pdu = scripted !== undefined
        ? scripted
        : s.fr !== undefined
        ? s.fr.event(id)
        : null;
      if (pdu === undefined || pdu === null) {
        return Response.json(
          { errcode: 'M_NOT_FOUND', error: 'not here' },
          { status: 404 },
        );
      }
      return Response.json({
        origin: 'fake',
        origin_server_ts: Date.now(),
        pdus: [wireOf(pdu)],
      });
    }
    if (path.startsWith('/_matrix/federation/v1/backfill/')) {
      const from = req.url.searchParams.getAll('v');
      const limit = Number(req.url.searchParams.get('limit') ?? '0');
      s.backfillQueries.push({ from, limit });
      const pdus = s.fr !== undefined ? s.fr.backfillPdus(from, limit) : [];
      return Response.json({
        origin: 'fake',
        origin_server_ts: Date.now(),
        pdus: pdus.map(wireOf),
      });
    }
    if (path.startsWith('/_matrix/federation/v1/make_join/')) {
      const userId = decodeURIComponent(path.split('/').pop()!);
      const answer = s.fr!.makeJoinAnswer(userId);
      return Response.json({
        room_version: answer.roomVersion,
        event: wireOf(answer.event),
      });
    }
    if (path.startsWith('/_matrix/federation/v2/send_join/')) {
      // the wire body has no event_id — the resident restores it from
      // the path (joins-v2.yaml)
      const eventId = decodeURIComponent(path.split('/').pop()!);
      const join = req.json() as Pdu;
      join.event_id = eventId;
      return s.fr!.acceptSendJoin(join).then((resp) =>
        Response.json({
          state: resp.state.map(wireOf),
          auth_chain: resp.authChain.map(wireOf),
          event: wireOf(resp.event),
          members_omitted: false,
          servers_in_room: [],
        })
      );
    }
    return null;
  };
}

async function ourPubB64(signer: Signer): Promise<string> {
  const pub = (await testRemoteServer(signer.serverName)).kp.publicKey;
  return b64encodeStd(await exportPublicKeyRaw(pub));
}

function productionDeps(server: Db, signer: Signer): RemoteDeps {
  return {
    keys: productionKeyResolver(server, signer),
    fetcher: productionFetcher(server, signer),
    self: signer.serverName,
    limits: { waitMs: 25, limit: 10, budgetMs: 8000 },
    ungroundedMs: 3_600_000,
  };
}

function withCa<T>(fn: () => Promise<T>): Promise<T> {
  setConfigForTests({
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  return fn();
}

type Boot = {
  g: Genesis;
  fake: FakeServer;
  remote: RemoteServer;
  deps: RemoteDeps;
  server: Db;
  scripted: Scripted;
  joinId: string;
  rudy: string;
};

// A public room of ours + the fake's user joined into it over the
// production resolver (the first contact acquires the fake's document).
async function boot(store: Store, opts: { roomId: string }): Promise<Boot> {
  const g = await genesis(store, { roomId: opts.roomId, joinRule: 'public' });
  const server = await store.server();
  const scripted = newScripted();
  const fake = await startFakeServer({
    ourKeyDoc: async () => ourKeyDocument(g.signer, await ourPubB64(g.signer)),
    handlers: handlersOf(scripted),
  });
  const remote: RemoteServer = {
    name: fake.name,
    keyId: fake.keyId,
    kp: fake.kp,
  };
  const deps = productionDeps(server, g.signer);
  const rudy = '@rudy:' + remote.name;
  const join = await remoteEvent(g.roomId, remote, '11', {
    type: 'm.room.member',
    sender: rudy,
    state_key: rudy,
    content: { membership: 'join' },
    prev_events: [g.tipId],
    auth_events: [g.createId],
    origin_server_ts: 100,
  });
  const joined = await ingestRemote(g.room, [join], remote.name, deps);
  assertEquals(joined[0].outcome, 'accepted');
  return {
    g,
    fake,
    remote,
    deps,
    server,
    scripted,
    joinId: String(join.event_id),
    rudy,
  };
}

async function msg(
  b: Boot,
  body: string,
  prevIds: string[],
  depth: number,
): Promise<Pdu> {
  return await remoteEvent(b.g.roomId, b.remote, '11', {
    type: 'm.room.message',
    sender: b.rudy,
    content: { msgtype: 'm.text', body },
    prev_events: prevIds,
    auth_events: [b.g.createId],
    depth,
    origin_server_ts: 1000 + depth,
  });
}

Deno.test('fetcher: the first contact acquires the peer key document (signed, cached) and verifies its PDUs', async () => {
  await withCa(async () => {
    await withStore(async (store) => {
      const b = await boot(store, { roomId: '!ff1:test' });
      try {
        // the acquisition dialed the fake's key endpoint with our
        // X-Matrix, verified by the fake
        const keyFetch = b.fake.requests.find((r) =>
          r.path === '/_matrix/key/v2/server'
        );
        assert(keyFetch !== undefined, 'no key fetch recorded');
        assertEquals(keyFetch.method, 'GET');
        assertEquals(keyFetch.verified, true);
        // the document is cached in the server file, via direct
        const rows = await b.server.query(
          'SELECT via FROM server_key_docs WHERE server_name = ?',
          [b.remote.name],
        );
        assertEquals(rows.length, 1);
        assertEquals(String(rows[0].via), 'direct');
        // and the join it verified landed accepted (boot asserts that)
        const status = await b.g.room.tx((tx) => tx.events.getStatus(b.joinId));
        assertEquals(status?.standing, 'accepted');
      } finally {
        await b.fake.close();
      }
    });
  });
});

Deno.test('fetcher: the missing-events chase over TLS — request shape, verified answers in depth order', async () => {
  await withCa(async () => {
    await withStore(async (store) => {
      const b = await boot(store, { roomId: '!ff2:test' });
      try {
        const p0 = await msg(b, 'p0', [b.joinId], 50);
        const p1 = await msg(b, 'p1', [String(p0.event_id)], 51);
        b.scripted.missingAnswers = [p1, p0]; // deliberately out of order
        const pushed = await msg(b, 'pushed', [String(p1.event_id)], 52);
        const outcomes = await ingestRemote(
          b.g.room,
          [pushed],
          b.remote.name,
          b.deps,
        );
        assertEquals(outcomes[0].outcome, 'accepted');
        // the request shape: one POST, earliest = our extremities,
        // latest = the pushed event, limit = missinglimit, min_depth 0
        assertEquals(b.scripted.missingBodies.length, 1);
        assertEquals(b.scripted.missingBodies[0], {
          earliest_events: [b.joinId],
          latest_events: [String(pushed.event_id)],
          limit: 10,
          min_depth: 0,
        });
        const post = b.fake.requests.find((r) =>
          r.path.startsWith('/_matrix/federation/v1/get_missing_events/')
        );
        assert(post !== undefined);
        assertEquals(post.verified, true);
        // positions prove the ingest order: p0, p1, pushed
        const offsets = await b.g.room.tx(async (tx) => {
          const at = async (id: string) =>
            (await tx.segments.positionOf(id))?.offset ?? null;
          return {
            p0: await at(String(p0.event_id)),
            p1: await at(String(p1.event_id)),
            pushed: await at(String(pushed.event_id)),
          };
        });
        assert(
          offsets.p0 !== null && offsets.p1 !== null &&
            offsets.pushed !== null,
        );
        assert(offsets.p0 < offsets.p1 && offsets.p1 < offsets.pushed);
      } finally {
        await b.fake.close();
      }
    });
  });
});

Deno.test('fetcher: /state_ids + /event packs the gap tip over TLS (imported boundary)', async () => {
  await withCa(async () => {
    await withStore(async (store) => {
      const b = await boot(store, { roomId: '!ff3:test' });
      try {
        // the gap tip: a member join for zoe, citing a genuinely absent
        // prev — its before-state can only be the remote's answer (G1)
        const zoeUser = '@zoe:' + b.remote.name;
        const zoe = await remoteEvent(b.g.roomId, b.remote, '11', {
          type: 'm.room.member',
          sender: zoeUser,
          state_key: zoeUser,
          content: { membership: 'join' },
          prev_events: ['$zoe-parent-we-never-held'],
          auth_events: [b.g.createId],
          depth: 50,
          origin_server_ts: 150,
        });
        const topic = await remoteEvent(b.g.roomId, b.remote, '11', {
          type: 'm.room.topic',
          sender: zoeUser,
          state_key: '',
          content: { topic: 'on the wire' },
          prev_events: [b.joinId],
          auth_events: [b.g.createId],
          depth: 49,
          origin_server_ts: 140,
        });
        const stateIds = await b.g.room.tx(async (tx) => {
          const stay = await tx.segments.openStay();
          const group = await tx.state.current(stay!.id);
          return [...(await tx.state.groupMap(group!)).values()];
        });
        b.scripted.missingAnswers = []; // nothing from get_missing_events
        b.scripted.stateIds.set(String(zoe.event_id), {
          pdu_ids: [...stateIds, String(topic.event_id)],
          auth_chain_ids: [b.g.createId],
        });
        b.scripted.events.set(String(zoe.event_id), zoe);
        b.scripted.events.set(String(topic.event_id), topic);
        const pushed = await msg(b, 'pushed', [String(zoe.event_id)], 51);
        const outcomes = await ingestRemote(
          b.g.room,
          [pushed],
          b.remote.name,
          b.deps,
        );
        assertEquals(outcomes[0].outcome, 'accepted');
        // the fake saw /state_ids and /event for the gap tip
        assert(
          b.fake.requests.some((r) =>
            r.path.startsWith('/_matrix/federation/v1/state_ids/') &&
            r.path.includes(encodeURIComponent(String(zoe.event_id)))
          ),
          'no /state_ids for the gap tip',
        );
        await b.g.room.tx(async (tx) => {
          // the gap tip landed LIVE with the imported boundary (R5, G1)
          const status = await tx.events.getStatus(String(zoe.event_id));
          assertEquals(status?.standing, 'accepted');
          assertEquals(status?.grounding, 'grounded');
          const before = await tx.state.eventStateBefore(
            String(zoe.event_id),
          );
          assertEquals(before?.provenance, 'imported');
        });
      } finally {
        await b.fake.close();
      }
    });
  });
});

Deno.test('fetcher: make_join/send_join over TLS, then backfill into the joined room', async () => {
  await withCa(async () => {
    await withStore(async (store) => {
      const signer = await testSigner();
      const server = await store.server();
      const scripted = newScripted();
      const fake = await startFakeServer({
        ourKeyDoc: async () => ourKeyDocument(signer, await ourPubB64(signer)),
        handlers: handlersOf(scripted),
      });
      try {
        // a remote-owned room with a few events of history, signed by
        // the fake's own identity
        scripted.fr = await makeFakeRoom({
          roomId: '!ff4:' + fake.name,
          server: {
            name: fake.name,
            keyId: fake.keyId,
            kp: fake.kp,
          },
          joinRule: 'public',
        });
        await fakeMessage(scripted.fr, 'history one', {
          origin_server_ts: 10,
        });
        await fakeMessage(scripted.fr, 'history two', {
          origin_server_ts: 20,
        });
        await fakeMessage(scripted.fr, 'history three', {
          origin_server_ts: 30,
        });
        const deps = productionDeps(server, signer);
        // the join dance over TLS: make_join → send_join
        const result = await joinRemote(store, {
          roomId: scripted.fr.roomId,
          user: '@dev:' + signer.serverName,
          via: [fake.name],
          signer,
          deps,
        });
        assertEquals(result.roomId, scripted.fr.roomId);
        const makeJoinReq = fake.requests.find((r) =>
          r.path.startsWith('/_matrix/federation/v1/make_join/')
        );
        assert(makeJoinReq !== undefined, 'no make_join call');
        assert(makeJoinReq.path.includes('ver='), 'make_join carries ver');
        assertEquals(makeJoinReq.verified, true);
        const sendJoinReq = fake.requests.find((r) =>
          r.path.startsWith('/_matrix/federation/v2/send_join/')
        );
        assert(sendJoinReq !== undefined, 'no send_join call');
        assertEquals(sendJoinReq.method, 'PUT');
        assertEquals(sendJoinReq.verified, true);
        // the wire body carried no event_id; the path did
        assert(
          sendJoinReq.path.includes(encodeURIComponent(result.eventId)),
        );
        assert(sendJoinReq.body !== null);
        assert(
          !new TextDecoder().decode(sendJoinReq.body).includes('"event_id"'),
          'the wire body carries no event_id',
        );
        // the room file exists with our join published and projected
        const room = await openRoom(store, scripted.fr.roomId);
        const memberRows = await server.query(
          'SELECT membership FROM memberships WHERE room = ? AND user = ?',
          [scripted.fr.roomId, '@dev:' + signer.serverName],
        );
        assertEquals(memberRows.length, 1);
        assertEquals(String(memberRows[0].membership), 'join');
        // backfill into the join's prevs over TLS: the fake's history
        // lands in the stay's history segment, oldest first
        const joinPrevs = await room.tx(async (tx) => {
          const row = await tx.events.get(result.eventId);
          return (JSON.parse(row!.pdu) as Pdu).prev_events ?? [];
        });
        assert(joinPrevs.length > 0);
        const page = await backfill(
          room,
          { from: joinPrevs, limit: 10, via: fake.name },
          deps,
        );
        // the page walks back to the room's create: the gap closes
        assertEquals(page.outcome, 'complete');
        assert(page.positioned.length > 0);
        assertEquals(scripted.backfillQueries.length, 1);
        assertEquals(scripted.backfillQueries[0].from, joinPrevs);
        const offsets = await room.tx(async (tx) => {
          const out: number[] = [];
          for (const id of page.positioned) {
            const pos = await tx.segments.positionOf(id);
            assert(pos !== null);
            out.push(pos.offset);
          }
          return out;
        });
        for (let i = 0; i < offsets.length; i++) {
          assert(offsets[i] < 0, 'history positions are below the live 0+');
          if (i > 0) assert(offsets[i - 1] < offsets[i], 'oldest first');
        }
      } finally {
        await fake.close();
      }
    });
  });
});

Deno.test('key resolver: refuses an unknown key id and a wrong key', async () => {
  await withCa(async () => {
    await withStore(async (store) => {
      const b = await boot(store, { roomId: '!ff5:test' });
      try {
        const resolver = productionKeyResolver(b.server, b.g.signer);
        const signed = await msg(b, 'signed', [b.joinId], 60);
        // the fake's own signed PDU verifies (the production half of the
        // 3c verification path)
        const ok = await resolver.verifyEventSignature({
          server: b.remote.name,
          keyId: b.remote.keyId,
          pdu: signed,
          roomVersion: '11',
          minValidUntilMs: Number(signed.origin_server_ts),
        });
        assertEquals(ok, true);
        // a key id the document does not carry → false
        assertEquals(
          await resolver.verifyEventSignature({
            server: b.remote.name,
            keyId: 'ed25519:nope',
            pdu: signed,
            roomVersion: '11',
            minValidUntilMs: Number(signed.origin_server_ts),
          }),
          false,
        );
        // a PDU signed with a DIFFERENT key under the served id → false
        const other = await makeRemoteServer(b.remote.name);
        other.keyId = b.remote.keyId;
        const forged = await remoteEvent(b.g.roomId, other, '11', {
          type: 'm.room.message',
          sender: b.rudy,
          content: { msgtype: 'm.text', body: 'forged' },
          prev_events: [b.joinId],
          auth_events: [b.g.createId],
          depth: 61,
          origin_server_ts: 1061,
        });
        assertEquals(
          await resolver.verifyEventSignature({
            server: b.remote.name,
            keyId: b.remote.keyId,
            pdu: forged,
            roomVersion: '11',
            minValidUntilMs: Number(forged.origin_server_ts),
          }),
          false,
        );
      } finally {
        await b.fake.close();
      }
    });
  });
});

Deno.test('key resolver: refuses an expired document for a later event', async () => {
  await withCa(async () => {
    await withStore(async (store) => {
      const signer = await testSigner();
      const server = await store.server();
      // the fake serves an EXPIRED document for itself (handlers are
      // consulted before the built-ins; fake is assigned before any
      // request arrives)
      let fake: FakeServer | null = null;
      const started = await startFakeServer({
        ourKeyDoc: async () => ourKeyDocument(signer, await ourPubB64(signer)),
        handlers: (req): Response | Promise<Response> | null => {
          if (req.url.pathname === '/_matrix/key/v2/server') {
            return makeDoc({
              name: fake!.name,
              keyId: fake!.keyId,
              kp: fake!.kp,
            }, { validUntilMs: Date.now() - 60_000 }).then((doc) =>
              Response.json(doc)
            );
          }
          return null;
        },
      });
      fake = started;
      try {
        const remote: RemoteServer = {
          name: fake.name,
          keyId: fake.keyId,
          kp: fake.kp,
        };
        const resolver = productionKeyResolver(server, signer);
        const pdu = await remoteEvent('!ff6:test', remote, '11', {
          type: 'm.room.message',
          sender: '@rudy:' + remote.name,
          content: { msgtype: 'm.text', body: 'late' },
          prev_events: [],
          auth_events: [],
          depth: 10,
          origin_server_ts: Date.now(),
        });
        assertEquals(
          await resolver.verifyEventSignature({
            server: remote.name,
            keyId: remote.keyId,
            pdu,
            roomVersion: '11',
            minValidUntilMs: Number(pdu.origin_server_ts),
          }),
          false,
        );
      } finally {
        await fake.close();
      }
    });
  });
});
