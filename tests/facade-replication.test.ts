import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  closeApp,
  openReplicaApp,
  startFederationServices,
  theApp,
} from '#engine/app.ts';
import { setConfigForTests } from '#engine/config.ts';
import { claimKeys, queryKeys } from '#engine/client/e2ee.ts';
import {
  createRoom as createClientRoom,
  redactEvent,
  sendEvent,
  writeStateKey,
} from '#engine/client/write.ts';
import { type PreparedSubmission, sendLocal } from '#engine/room/ingest.ts';
import * as localMembership from '#engine/room/membership.ts';
import { deviceListService } from '#engine/federation/device-lists.ts';
import { eduState } from '#engine/federation/edus.ts';
import { reconcileDeviceRoom } from '#engine/server/e2ee.ts';
import { startFakeServer } from './federation/fake-server.ts';
import { serveDeps } from '#engine/federation/context.ts';
import { serveEvent } from '#engine/federation/serve.ts';
import { admit } from '#engine/federation/gate.ts';
import { federationPolicy } from '#engine/federation/policy.ts';
import { keyStore } from '#engine/federation/keys.ts';
import * as serving from '#engine/federation/serve.ts';
import { pathfinder } from '@pathfinder/pathfinder';
import {
  directOnly,
  makeDoc,
  makeServer,
  seedServer,
} from './federation/doc-helper.ts';
import { fedCaller } from './http-federation.ts';
import { enrolledTenant, initializeNode } from '#engine/facade/identity.ts';
import {
  exportPublicReplica,
  PublicReplicas,
  startPublicExports,
} from '#engine/facade/public.ts';
import {
  DirectoryReplicas,
  exportDirectoryReplica,
  startDirectoryExports,
} from '#engine/facade/directory.ts';
import {
  addBlock,
  addPeer,
  isBlocked,
  listPeers,
  removeBlock,
  removePeer,
} from '#engine/federation/peers.ts';
import {
  lookupAlias,
  registerAlias,
  removeAlias,
} from '#engine/server/aliases.ts';
import { listedRooms, setVisibility } from '#engine/server/directory.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { setReceipt as writeClientReceipt } from '#engine/receipts.ts';
import { appendRecord, Journal } from '#engine/facade/journal.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { LINK_CAPABILITIES, LINK_SUPPORTED } from '#engine/facade/protocol.ts';
import { applyReplicaScope } from '#engine/facade/scopes.ts';
import type { Database } from '#engine/store/db.ts';
import {
  exportRoomReplica,
  RoomReplicas,
  startRoomExports,
} from '#engine/facade/replication.ts';
import { bounded } from './helpers/server-process.ts';
import type { Pdu } from '#engine/pdu.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { setRoomHooks } from '#engine/room/hooks.ts';
import { importReplicaGenesis } from '#engine/room/replica.ts';
import { importReplicaRoom } from '#engine/room/replica-import.ts';
import { stageSnapshotEvidence } from '#engine/room/snapshot-install.ts';
import { verifySnapshot } from '#engine/room/snapshot.ts';
import { exportReplicaRoom } from '#engine/room/replica-export.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { redact } from '#engine/eventid.ts';
import { b64encodeStd } from '#engine/signing-primitives.js';
import { ingestRemote } from '#engine/room/remote.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { historicalServerSchema } from './fixtures/server-schema-history.ts';
import {
  membershipOf as projectedMembershipOf,
  roomOf,
} from '#engine/server/read.ts';
import { installServerHooks, recoverServer } from '#engine/server/startup.ts';
import { registerRoom } from '#engine/server/registry.ts';
import { project } from '#engine/server/project.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
} from './fixtures/remote.ts';
import { makeFakeRoom } from './fixtures/remote-room.ts';

async function fixture(seedServer = serverSchema, version = '11') {
  const dir = await Deno.makeTempDir({ prefix: 'facade-replication-' });
  const open = (name: string, schema = serverSchema) =>
    openStore({
      dir: dir + '/' + name,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, {
      schemas: { server: schema, tenant: tenantSchema, room: roomSchema },
    });
  let home = await open('home', seedServer);
  let edge = await open('edge', seedServer);
  const tenant = await openTenant(home, 'logical.test', { create: true });
  const node = await initializeNode(
    await edge.server(),
    tenant.serverName,
    'edge_a',
  );
  let hp = new Pairings(
    await home.server(),
    tenant.signer(),
    tenant.publicB64,
    'a'.repeat(64),
  );
  const edgePairings = async () =>
    new Pairings(
      await edge.server(),
      node.signer(),
      node.publicKey,
      'b'.repeat(64),
      node,
    );
  const fp = await edgePairings();
  const bundle = await hp.create({
    node: node.node,
    url: 'https://facade.test',
    facadePin: 'b'.repeat(64),
    expires: Date.now() + 60000,
    required: [...LINK_CAPABILITIES],
  });
  await fp.accept(bundle);
  const grant = await hp.grant(
    bundle.id,
    await fp.challenge(bundle.id, bundle.secret, 'a'.repeat(64)),
  );
  await hp.confirm(
    bundle.id,
    await fp.complete(bundle.id, grant, 'a'.repeat(64)),
  );
  const signing = await makeRemoteServer(tenant.serverName);
  const source = await makeFakeRoom({
    roomId: '!replicated:logical.test',
    server: signing,
    version,
  });
  const keys = fakeKeyResolver(signing);
  const pdus = [...source.events.values()];
  await importReplicaGenesis(home, {
    roomId: source.roomId,
    roomVersion: source.version,
    self: signing.name,
    keys,
    create: pdus[0],
    join: pdus[1],
  });
  const room = await openRoom(home, source.roomId);
  const ingest = (pdus: Pdu[]) =>
    ingestRemote(room, pdus, signing.name, {
      keys,
      self: signing.name,
      fetcher: fakeFetcher({}).fetcher,
      limits: { waitMs: 0, limit: 100, budgetMs: 1000 },
      ungroundedMs: 3600000,
    });
  await ingest(pdus.slice(2));
  const exports = () =>
    exportRoomReplica(home, room, signing.name, node.node, bundle.id);
  const journal = async () =>
    new Journal(await edge.server(), LINK_CAPABILITIES);
  const replicas = async () =>
    new RoomReplicas(edge, await edgePairings(), signing.name, keys);
  return {
    get home() {
      return home;
    },
    get homePairings() {
      return hp;
    },
    source,
    room,
    ingest,
    exports,
    journal,
    replicas,
    node,
    bundle,
    signing,
    tenant,
    async publicOwner() {
      const pairings = await edgePairings();
      return new PublicReplicas(
        edge,
        await enrolledTenant(edge, pairings, tenant.serverName, node.node),
        pairings,
      );
    },
    publicExport: () =>
      exportPublicReplica(home, tenant, 'alice', node.node, bundle.id),
    directoryExport: async () => {
      await recoverServer(home);
      return await exportDirectoryReplica(home, tenant, node.node, bundle.id);
    },
    directoryOwner: async () =>
      new DirectoryReplicas(
        await edge.server(),
        await edgePairings(),
        tenant.serverName,
      ),
    edgeServer: () => edge.server(),
    edgePairings,
    edgeStore: () => edge,
    edgeTenant: async () =>
      enrolledTenant(edge, await edgePairings(), tenant.serverName, node.node),
    async retire() {
      await (await edge.server()).execute(
        "UPDATE facade_pairings SET state='revoked' WHERE id=?",
        [bundle.id],
      );
    },
    replica: () => openRoom(edge, source.roomId),
    async downgrade() {
      await (await edge.server()).tx(async (conn) => {
        await conn.exec(
          'DROP TABLE facade_egress_routes; DROP TABLE facade_egress; DROP TABLE facade_ingress_collisions; DROP TABLE facade_ingress_children; DROP TABLE facade_ingress; DROP TABLE server_key_decisions; DROP TABLE federation_policy; DROP TABLE facade_scopes; DROP TABLE facade_exports',
        );
        await conn.execute("UPDATE meta SET v='30' WHERE k='schema_version'");
      }, { mode: 'deferred' });
    },
    async reopen() {
      await edge.close();
      edge = await open('edge');
    },
    async reopenHome() {
      await home.close();
      home = await open('home');
      hp = new Pairings(
        await home.server(),
        tenant.signer(),
        tenant.publicB64,
        'a'.repeat(64),
      );
    },
    async close() {
      await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('replica signature-only packs authenticate the actual room version before any overlay commit', async () => {
  const f = await fixture(serverSchema, '5');
  try {
    const initial = await f.exports();
    assert(initial);
    const journal = await f.journal();
    await journal.receive('home', [initial]);
    await (await f.replicas()).apply(journal, initial);
    const replica = await f.replica();
    const head = await replica.tx((tx) => tx.changes.head());
    const manifest = await exportReplicaRoom(f.room, f.tenant.serverName);
    manifest.after = manifest.cut;
    manifest.steps = [];
    // v4 and v5 share event hashing/redaction, but only the real v5 version
    // enforces this key's validity floor. The signed create still declares v5.
    manifest.roomVersion = '4';
    const target = manifest.events.find((pdu) => pdu.type === 'm.room.create')!;
    const witness = await makeRemoteServer('expired.test', { validUntilMs: 0 });
    const body = redact(target as unknown as Record<string, unknown>, '4');
    delete body.event_id;
    delete body.signatures;
    target.signatures[witness.name] = {
      [witness.keyId]: b64encodeStd(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: 'Ed25519' },
            witness.kp.privateKey,
            new TextEncoder().encode(canonicalJson(body)),
          ),
        ),
      ),
    };
    await assertRejects(() =>
      importReplicaRoom(f.edgeStore(), manifest, {
        self: f.tenant.serverName,
        keys: fakeKeyResolver(f.signing, witness),
        signatureUnion: true,
      })
    );
    assertEquals(await replica.tx((tx) => tx.changes.head()), head);
    const retained = JSON.parse(
      (await replica.tx((tx) => tx.events.get(String(target.event_id))))!.pdu,
    );
    assertEquals(retained.signatures[witness.name], undefined);
  } finally {
    await f.close();
  }
});

Deno.test('replica signature-only packs reject substituted creates before any retained overlay commit', async () => {
  const f = await fixture(serverSchema, '5');
  try {
    const initial = await f.exports();
    assert(initial);
    const journal = await f.journal();
    await journal.receive('home', [initial]);
    await (await f.replicas()).apply(journal, initial);
    const replica = await f.replica();
    const head = await replica.tx((tx) => tx.changes.head());
    const manifest = await exportReplicaRoom(f.room, f.tenant.serverName);
    manifest.after = manifest.cut;
    manifest.steps = [];
    manifest.roomVersion = '4';
    const target = manifest.events.find((pdu) => pdu.type === 'm.room.create')!;
    const witness = await makeRemoteServer('expired.test', { validUntilMs: 0 });
    const body = redact(target as unknown as Record<string, unknown>, '4');
    delete body.event_id;
    delete body.signatures;
    target.signatures[witness.name] = {
      [witness.keyId]: b64encodeStd(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: 'Ed25519' },
            witness.kp.privateKey,
            new TextEncoder().encode(canonicalJson(body)),
          ),
        ),
      ),
    };
    // A valid alternate create authenticates v4, but not this retained room.
    // Rejected auth-chain evidence must not confer that version on known PDUs.
    const substitute = await makeFakeRoom({
      roomId: manifest.roomId,
      server: f.signing,
      version: '4',
    });
    manifest.events.push(substitute.events.get(substitute.createId)!);
    manifest.stays[0].opening.createId = substitute.createId;
    await assertRejects(() =>
      importReplicaRoom(f.edgeStore(), manifest, {
        self: f.tenant.serverName,
        keys: fakeKeyResolver(f.signing, witness),
        signatureUnion: true,
      })
    );
    assertEquals(await replica.tx((tx) => tx.changes.head()), head);
    const retained = JSON.parse(
      (await replica.tx((tx) => tx.events.get(String(target.event_id))))!.pdu,
    );
    assertEquals(retained.signatures[witness.name], undefined);
  } finally {
    await f.close();
  }
});

Deno.test('replica v2 verified join bootstrap preserves evidence-only rooms with no prior participation', async () => {
  const f = await fixture();
  try {
    const manifest = await exportReplicaRoom(f.room, f.tenant.serverName);
    const keys = fakeKeyResolver(f.signing);
    const evidence = await verifySnapshot({
      self: f.tenant.serverName,
      keys,
      roomId: manifest.roomId,
      roomVersion: manifest.roomVersion,
      resident: f.tenant.serverName,
      state: [manifest.events.find((event) => event.type === 'm.room.create')!],
      authChain: manifest.events,
    });
    // Present the original signed creator join as an authentic snapshot opening,
    // not as an unpublished-file genesis. Its create belongs to before-state.
    const opening = manifest.stays[0].opening;
    opening.kind = 'join';
    manifest.boundaries.push({
      eventId: opening.eventId,
      resident: f.tenant.serverName,
      state: [opening.createId],
      authChain: [],
    });
    manifest.steps = manifest.steps.filter((step) =>
      step.eventId !== opening.createId
    );
    const room = await openRoom(f.edgeStore(), manifest.roomId, {
      create: true,
    });
    await room.tx((tx) => stageSnapshotEvidence(tx, evidence, opening.eventId));
    assertEquals(await room.tx((tx) => tx.segments.latestStay()), null);
    assert(await room.tx((tx) => tx.events.get(evidence.createId)));
    await importReplicaRoom(f.edgeStore(), manifest, {
      self: f.tenant.serverName,
      keys,
      signatureUnion: true,
    });
    assert(await room.tx((tx) => tx.segments.latestStay()));
    assertEquals(
      (await room.tx((tx) => tx.events.getStatus(opening.eventId)))
        ?.grounding,
      'grounded',
    );
  } finally {
    await f.close();
  }
});

Deno.test('replica signature-only packs union verified signatures without changing base bytes or live news', async () => {
  const f = await fixture();
  try {
    const initial = await f.exports();
    assert(initial);
    const journal = await f.journal();
    await journal.receive('home', [initial]);
    await (await f.replicas()).apply(journal, initial);
    const replica = await f.replica();
    const manifest = await exportReplicaRoom(f.room, f.tenant.serverName);
    manifest.after = manifest.cut;
    manifest.steps = [];
    const target = manifest.events.find((pdu) => pdu.type === 'm.room.create')!;
    const id = String(target.event_id);
    const witness = await makeRemoteServer('witness.test');
    const body = redact(
      target as unknown as Record<string, unknown>,
      manifest.roomVersion,
    );
    delete body.event_id;
    delete body.signatures;
    const signature = b64encodeStd(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'Ed25519' },
          witness.kp.privateKey,
          new TextEncoder().encode(canonicalJson(body)),
        ),
      ),
    );
    target.signatures![witness.name] = { [witness.keyId]: signature };
    const db = await f.edgeStore().room(replica.id);
    await project(f.edgeStore(), replica.id);
    const server = await f.edgeServer();
    const feed = await server.query(
      'SELECT * FROM feed WHERE room=? ORDER BY seq',
      [replica.id],
    );
    assert(feed.length > 0);
    const base = await db.query('SELECT pdu FROM events WHERE id=?', [id]);
    const head = await replica.tx((tx) => tx.changes.head());
    const position = await replica.tx((tx) => tx.segments.positionOf(id));
    const apply = () =>
      importReplicaRoom(f.edgeStore(), structuredClone(manifest), {
        self: f.tenant.serverName,
        keys: fakeKeyResolver(f.signing, witness),
        signatureUnion: true,
      });
    await apply();
    await project(f.edgeStore(), replica.id);
    assertEquals(
      await server.query('SELECT * FROM feed WHERE room=? ORDER BY seq', [
        replica.id,
      ]),
      feed,
    );
    assertEquals(
      JSON.parse((await replica.tx((tx) => tx.events.get(id)))!.pdu)
        .signatures[witness.name],
      {
        [witness.keyId]: signature,
      },
    );
    assertEquals(
      await db.query('SELECT pdu FROM events WHERE id=?', [id]),
      base,
    );
    assertEquals(
      await replica.tx((tx) => tx.segments.positionOf(id)),
      position,
    );
    const suffix = await exportReplicaRoom(replica, f.tenant.serverName, head);
    assertEquals(suffix.steps, []);
    assertEquals(suffix.cut, head + 1);
    assertEquals(
      suffix.events.find((pdu) => pdu.event_id === id)!
        .signatures![witness.name],
      {
        [witness.keyId]: signature,
      },
    );
    await apply();
    assertEquals(await replica.tx((tx) => tx.changes.head()), head + 1);
    await f.reopen();
    assertEquals(
      JSON.parse((await (await f.replica()).tx((tx) => tx.events.get(id)))!.pdu)
        .signatures[witness.name],
      {
        [witness.keyId]: signature,
      },
    );
    // A valid sender signature is not proof of an optional signature or of
    // unchanged full event material (content-hash redaction must not hide it).
    target.signatures![witness.name][witness.keyId] = 'A'.repeat(86);
    await assertRejects(apply);
    target.signatures![witness.name][witness.keyId] = signature;
    target.content = { ...target.content, injected: true };
    await assertRejects(apply);
    assertEquals(
      await (await f.replica()).tx((tx) => tx.changes.head()),
      head + 1,
    );
  } finally {
    await f.close();
  }
});

Deno.test('room replication pins bootstrap, applies only durable semantic suffixes, and completes readiness with its journal result', async () => {
  const f = await fixture();
  try {
    const initial = await f.exports();
    assert(initial);
    assertEquals(await f.exports(), null);
    const j = await f.journal();
    await j.receive('home', [initial]);
    assertEquals(await (await f.replicas()).status(f.source.roomId), null);
    assert(await (await f.replicas()).apply(j, initial));
    const ready = await (await f.replicas()).status(f.source.roomId);
    assertEquals(ready?.ready, true);
    const message = await f.source.addEvent({
      type: 'm.room.message',
      content: { body: 'new suffix' },
    });
    await f.ingest([message]);
    const suffix = await f.exports();
    assert(suffix);
    const body = suffix.payload as {
      manifest: { after: number; steps: { eventId: string }[] };
    };
    assertEquals(body.manifest.after, ready?.cut);
    assertEquals(body.manifest.steps.map((step) => step.eventId), [
      message.event_id,
    ]);
    await j.receive('home', [suffix]);
    await f.reopen();
    assert(await (await f.replicas()).apply(await f.journal(), suffix));
    const replica = await f.replica();
    assertEquals(
      await replica.tx(async (tx) =>
        (await tx.events.getStatus(String(message.event_id)))?.standing
      ),
      'accepted',
    );
    assert(
      await replica.tx((tx) =>
        tx.segments.positionOf(String(message.event_id))
      ),
    );
    const head = await replica.tx((tx) => tx.changes.head());
    assertEquals(
      (await (await f.replicas()).status(f.source.roomId))?.ready,
      true,
    );
    assertEquals(
      await (await f.replicas()).apply(await f.journal(), suffix),
      false,
    );
    assertEquals(await replica.tx((tx) => tx.changes.head()), head);
    assertEquals(
      (await (await f.journal()).heads('home', 'in', suffix)).applied.sequence,
      2,
    );
  } finally {
    await f.close();
  }
});

Deno.test('room replication exports an enrolled facade suffix under its own source incarnation', async () => {
  const f = await fixture();
  try {
    const initial = await f.exports();
    assert(initial);
    const journal = await f.journal();
    await journal.receive('home', [initial]);
    await (await f.replicas()).apply(journal, initial);
    const reverse = await exportRoomReplica(
      f.edgeStore(),
      await f.replica(),
      f.tenant.serverName,
      'home',
      f.bundle.id,
    );
    assert(reverse);
    assertEquals(reverse.source, f.node.node);
    assertEquals(reverse.incarnation, f.node.incarnation);
    assertEquals(reverse.version, 2);
    assertEquals(
      await exportRoomReplica(
        f.edgeStore(),
        await f.replica(),
        f.tenant.serverName,
        'home',
        f.bundle.id,
      ),
      null,
    );
    const incoming = new Journal(await f.home.server(), LINK_SUPPORTED);
    await incoming.receive(f.node.node, [reverse]);
    const owner = new RoomReplicas(
      f.home,
      f.homePairings,
      f.tenant.serverName,
      fakeKeyResolver(f.signing),
    );
    const head = await f.room.tx((tx) => tx.changes.head());
    assert(await owner.apply(incoming, reverse, f.bundle.id));
    assertEquals(await owner.apply(incoming, reverse, f.bundle.id), false);
    assertEquals(await f.room.tx((tx) => tx.changes.head()), head);

    const branch = f.source.tipId;
    const homeEvent = await f.source.addEvent({
      type: 'm.room.encrypted',
      prev_events: [branch],
      content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'home branch' },
    });
    const edgeEvent = await f.source.addEvent({
      type: 'm.room.encrypted',
      prev_events: [branch],
      content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'edge branch' },
    });
    await f.ingest([homeEvent]);
    const replica = await f.replica();
    await ingestRemote(replica, [edgeEvent], f.signing.name, {
      keys: fakeKeyResolver(f.signing),
      self: f.signing.name,
      fetcher: fakeFetcher({}).fetcher,
      limits: { waitMs: 0, limit: 100, budgetMs: 1000 },
      ungroundedMs: 3600000,
    });
    const edgeSuffix = await exportRoomReplica(
      f.edgeStore(),
      replica,
      f.tenant.serverName,
      'home',
      f.bundle.id,
    );
    assert(edgeSuffix);
    await incoming.receive(f.node.node, [edgeSuffix]);
    assert(await owner.apply(incoming, edgeSuffix, f.bundle.id));
    const homeSuffix = await exportRoomReplica(
      f.home,
      f.room,
      f.tenant.serverName,
      f.node.node,
      f.bundle.id,
      2,
    );
    assert(homeSuffix);
    const supported = new Journal(await f.edgeServer(), LINK_SUPPORTED);
    await supported.receive('home', [homeSuffix]);
    assert(await (await f.replicas()).apply(supported, homeSuffix));
    for (const room of [f.room, replica]) {
      for (const event of [homeEvent, edgeEvent]) {
        assertEquals(
          (await room.tx((tx) => tx.events.getStatus(String(event.event_id))))
            ?.standing,
          'accepted',
        );
        assert(
          await room.tx((tx) => tx.segments.positionOf(String(event.event_id))),
        );
        const news = await room.tx((tx) => tx.changes.after(0, 100));
        assertEquals(
          news.filter((change) =>
            change.kind === 'event' && change.event === event.event_id
          ).length,
          1,
        );
      }
    }
    const next = await exportRoomReplica(
      f.edgeStore(),
      replica,
      f.tenant.serverName,
      'home',
      f.bundle.id,
    );
    assert(next);
    await incoming.receive(f.node.node, [next]);
    const manifest =
      (next.payload as { manifest: { after: number; cut: number } }).manifest;
    // The room commit may finish across a concurrent grant change, but its
    // journal result/readiness must not cross that authority fence.
    await assertRejects(
      async () =>
        await applyReplicaScope({
          db: await f.home.server(),
          pairings: f.homePairings,
          self: f.tenant.serverName,
          journal: incoming,
          stream: next,
          record: next,
          scope: next.stream,
          after: manifest.after,
          cut: manifest.cut,
          pairing: f.bundle.id,
          apply: async () => {
            await (await f.home.server()).execute(
              'UPDATE facade_pairings SET grant_json=? WHERE id=?',
              ['{}', f.bundle.id],
            );
            return {};
          },
        }),
      Error,
      'replica grant changed',
    );
    assertEquals(
      (await incoming.heads(f.node.node, 'in', next)).applied.sequence,
      edgeSuffix.sequence,
    );
  } finally {
    await f.close();
  }
});

Deno.test('reverse room bootstrap requires selected authentic participation and survives cold retry', async () => {
  const f = await fixture();
  try {
    const source = await makeFakeRoom({
      roomId: '!facade-created:logical.test',
      server: f.signing,
    });
    const pdus = [...source.events.values()];
    const keys = fakeKeyResolver(f.signing);
    await importReplicaGenesis(f.edgeStore(), {
      roomId: source.roomId,
      roomVersion: source.version,
      self: f.signing.name,
      keys,
      create: pdus[0],
      join: pdus[1],
    });
    const room = await openRoom(f.edgeStore(), source.roomId);
    await ingestRemote(room, pdus.slice(2), f.signing.name, {
      keys,
      self: f.signing.name,
      fetcher: fakeFetcher({}).fetcher,
      limits: { waitMs: 0, limit: 100, budgetMs: 1000 },
      ungroundedMs: 3600000,
    });
    const record = await exportRoomReplica(
      f.edgeStore(),
      room,
      f.signing.name,
      'home',
      f.bundle.id,
    );
    assert(record);
    const oldReader = new Journal(await f.home.server(), LINK_CAPABILITIES);
    await assertRejects(
      () => oldReader.receive(f.node.node, [record]),
      Error,
      'unsupported record type',
    );
    const journal = new Journal(await f.home.server(), LINK_SUPPORTED);
    await journal.receive(f.node.node, [record]);
    const owner = new RoomReplicas(
      f.home,
      f.homePairings,
      f.signing.name,
      keys,
    );
    for (
      const changed of [{ source: 'home' }, { incarnation: 'foreign-store' }]
    ) {
      const forged = await (await f.edgeServer()).tx((conn) =>
        appendRecord(conn, 'home', {
          source: record.source,
          incarnation: record.incarnation,
          stream: record.stream,
          type: record.type,
          version: record.version,
          payload: record.payload,
          operationId: 'foreign-' + Object.keys(changed)[0],
          ...changed,
        })
      );
      await journal.receive(f.node.node, [forged]);
      await assertRejects(
        () => owner.apply(journal, forged, f.bundle.id),
        Error,
        'source or scope',
      );
      assertEquals((await f.home.rooms()).includes(source.roomId), false);
      assertEquals(
        (await journal.heads(f.node.node, 'in', forged)).applied.sequence,
        0,
      );
    }
    await assertRejects(
      () => owner.apply(journal, record, f.bundle.id),
      Error,
      'selected account',
    );
    assertEquals((await f.home.rooms()).includes(source.roomId), false);
    assertEquals(
      (await journal.heads(f.node.node, 'in', record)).applied.sequence,
      0,
    );
    // This is the selection fact owned by the auth exporter, not a prior room
    // export. No home room row exists for this authentic facade genesis.
    await (await f.home.server()).execute(
      'INSERT INTO facade_exports(peer,incarnation,scope,source_cut) VALUES(?,?,?,?)',
      [f.node.node, f.bundle.id, 'auth:' + source.creator, 1],
    );
    assert(await owner.apply(journal, record, f.bundle.id));
    const imported = await openRoom(f.home, source.roomId);
    const head = await imported.tx((tx) => tx.changes.head());
    await f.reopenHome();
    const reopened = new RoomReplicas(
      f.home,
      f.homePairings,
      f.signing.name,
      keys,
    );
    const resumed = new Journal(await f.home.server(), LINK_SUPPORTED);
    assertEquals(await reopened.apply(resumed, record, f.bundle.id), false);
    const held = await openRoom(f.home, source.roomId);
    assertEquals(await held.tx((tx) => tx.changes.head()), head);
    assertEquals(
      (await held.tx((tx) => tx.events.getStatus(source.tipId)))?.standing,
      'accepted',
    );
  } finally {
    await f.close();
  }
});

Deno.test('replica scope retry retains its pending identity without rewriting equal preparation', async () => {
  const f = await fixture();
  try {
    const record = await f.exports();
    assert(record);
    const journal = await f.journal();
    await journal.receive('home', [record]);
    const db = await f.edgeServer();
    let writes = 0;
    const observed: Database = {
      ...db,
      tx: (fn, options) =>
        db.tx((conn) =>
          fn(
            new Proxy(conn, {
              get(target, key) {
                if (key === 'execute') {
                  return async (
                    sql: string,
                    args: Parameters<typeof conn.execute>[1],
                  ) => {
                    const n = await conn.execute(sql, args);
                    if (sql.startsWith('INSERT INTO facade_scopes')) {
                      writes += n;
                    }
                    return n;
                  };
                }
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ), options),
    };
    const options = {
      db: observed,
      pairings: await f.edgePairings(),
      self: f.signing.name,
      journal,
      stream: record,
      record,
      scope: record.stream,
      after: 0,
      cut: 1,
      apply: () => Promise.reject(new Error('domain interrupted')),
    };
    await assertRejects(
      () => applyReplicaScope(options),
      Error,
      'domain interrupted',
    );
    writes = 0;
    const start = performance.now();
    await assertRejects(
      () => applyReplicaScope(options),
      Error,
      'domain interrupted',
    );
    console.log(
      JSON.stringify({
        owner: 'replica pending preparation replay',
        writes,
        elapsed_ms: performance.now() - start,
      }),
    );
    assertEquals(writes, 0);
    assertEquals(
      (await journal.heads('home', 'in', record)).applied.sequence,
      0,
    );
    assertEquals(await (await f.replicas()).apply(journal, record), true);
    assertEquals(
      (await (await f.replicas()).status(f.source.roomId))?.ready,
      true,
    );
  } finally {
    await f.close();
  }
});

Deno.test('home room export progresses past a busy or broken room, skips evidence-only files, and drains admitted work', async () => {
  const f = await fixture();
  const blocked = await openRoom(f.home, '!busy:logical.test', {
    create: true,
  });
  await blocked.tx((tx) => tx.segments.create({ kind: 'stay' }));
  await openRoom(f.home, '!evidence:logical.test', { create: true });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const held = blocked.tx(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const exported = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<unknown>();
  const worker = startRoomExports({
    store: f.home,
    self: f.signing.name,
    peer: f.node.node,
    pairing: f.bundle.id,
    changed: () => exported.resolve(),
    failed: (error) => failed.resolve(error),
  });
  try {
    worker.wake();
    await bounded(exported.promise);
    const streams = await new Journal(await f.home.server(), LINK_CAPABILITIES)
      .streams(f.node.node, 'out');
    assertEquals(streams.map((stream) => stream.stream), [
      'room:' + f.source.roomId,
    ]);
    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assertEquals(closed, false);
    release.resolve();
    await held;
    await bounded(failed.promise);
    await bounded(closing);
  } finally {
    release.resolve();
    await held;
    await worker.close();
    await f.close();
  }
});

for (const domain of ['room', 'public', 'directory'] as const) {
  Deno.test(`${domain} exports wake at the committed source without a periodic coordinator tick`, async () => {
    const f = await fixture();
    const initial = Promise.withResolvers<void>();
    const suffix = Promise.withResolvers<void>();
    const failures: unknown[] = [];
    let changes = 0;
    const common = {
      store: f.home,
      tenant: f.tenant,
      self: f.signing.name,
      peer: f.node.node,
      pairing: f.bundle.id,
      changed: () => {
        if (++changes === 1) initial.resolve();
        else suffix.resolve();
      },
      failed: (error: unknown) => failures.push(error),
    };
    await f.tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
    await recoverServer(f.home);
    const worker = domain === 'room'
      ? startRoomExports(common)
      : domain === 'public'
      ? startPublicExports(common)
      : startDirectoryExports(common);
    try {
      worker.wake();
      await bounded(initial.promise, 3000);
      if (domain === 'room') {
        const message = await f.source.addEvent({
          type: 'm.room.message',
          content: { body: 'source wake' },
        });
        await f.ingest([message]);
        await project(f.home, f.room.id);
      } else {
        await f.tenant.tx((tx) =>
          tx.profiles.set('alice', 'displayname', 'Source wake')
        );
      }
      await bounded(suffix.promise, 3000);
      assertEquals(failures, []);
      assert(changes >= 2);
    } finally {
      await worker.close();
      await f.close();
    }
  });
}

for (const domain of ['room', 'public'] as const) {
  for (const fault of ['export', 'enumeration'] as const) {
    Deno.test(`${domain} exports retain a wake across a failed ${fault} pass`, async () => {
      const f = await fixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const rescanned = Promise.withResolvers<void>();
      const delivered = Promise.withResolvers<void>();
      const failed: unknown[] = [];
      const failure = new Error('injected export pass failure');
      let injected = false;
      let scans = 0;
      await f.tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
      const enumerate = async <T>(read: () => Promise<T>) => {
        scans++;
        if (fault === 'enumeration' && !injected) {
          injected = true;
          entered.resolve();
          await release.promise;
          throw failure;
        }
        const value = await read();
        if (scans > 1) setTimeout(() => rescanned.resolve(), 0);
        return value;
      };
      const rooms = f.home.rooms.bind(f.home);
      const tx = f.tenant.tx.bind(f.tenant);
      if (domain === 'room') f.home.rooms = () => enumerate(rooms);
      else {
        f.tenant.tx = (action) =>
          tx((current) => {
            const users = current.publicReplica.users;
            current.publicReplica.users = () => enumerate(users);
            return action(current);
          });
      }
      const db = await f.home.server();
      const query = db.query.bind(db);
      db.query = async (sql, values) => {
        if (
          fault === 'export' && !injected &&
          sql.startsWith('SELECT source_cut FROM facade_exports')
        ) {
          injected = true;
          entered.resolve();
          await release.promise;
          throw failure;
        }
        return await query(sql, values);
      };
      const common = {
        store: f.home,
        tenant: f.tenant,
        self: f.signing.name,
        peer: f.node.node,
        pairing: f.bundle.id,
        changed: () => delivered.resolve(),
        failed: (error: unknown) => failed.push(error),
      };
      const worker = domain === 'room'
        ? startRoomExports(common)
        : startPublicExports(common);
      try {
        worker.wake();
        await bounded(entered.promise, 3000);
        worker.wake();
        if (fault === 'export') await bounded(rescanned.promise, 3000);
        release.resolve();
        await bounded(delivered.promise, 3000);
        assertEquals(failed, [failure]);
      } finally {
        release.resolve();
        await worker.close();
        f.home.rooms = rooms;
        f.tenant.tx = tx;
        db.query = query;
        await f.close();
      }
    });
  }
}

Deno.test('room commit before completion survives reopen without readiness or duplicate publication', async () => {
  const f = await fixture();
  try {
    const record = await f.exports();
    assert(record);
    const journal = await f.journal();
    await journal.receive('home', [record]);
    journal.apply = () =>
      Promise.reject(new Error('crash before server completion'));
    await assertRejects(
      async () => (await f.replicas()).apply(journal, record),
      Error,
      'crash before server completion',
    );
    const replica = await f.replica();
    const head = await replica.tx((tx) => tx.changes.head());
    assert(head > 0);
    assertEquals(
      (await (await f.replicas()).status(f.source.roomId))?.ready,
      false,
    );
    assertEquals(
      (await journal.heads('home', 'in', record)).applied.sequence,
      0,
    );
    await f.reopen();
    assert(await (await f.replicas()).apply(await f.journal(), record));
    assertEquals(await (await f.replica()).tx((tx) => tx.changes.head()), head);
    assertEquals(
      (await (await f.replicas()).status(f.source.roomId))?.ready,
      true,
    );
  } finally {
    await f.close();
  }
});

Deno.test('v29 server files append scope ownership before room replication', async () => {
  const f = await fixture(historicalServerSchema(35));
  try {
    await f.downgrade();
    await f.reopen();
    const record = await f.exports();
    assert(record);
    await (await f.journal()).receive('home', [record]);
    assert(await (await f.replicas()).apply(await f.journal(), record));
    assertEquals(
      (await (await f.replicas()).status(f.source.roomId))?.ready,
      true,
    );
  } finally {
    await f.close();
  }
});

Deno.test('scope introspection uses its captured pairing cut even after live authority is revoked', async () => {
  const f = await fixture();
  try {
    const record = await f.exports();
    assert(record);
    await (await f.journal()).receive('home', [record]);
    const owner = await f.replicas();
    await owner.apply(await f.journal(), record);
    const captured = await owner.scopes();
    await f.retire();
    await assertRejects(() => owner.scopes());
    assertEquals(await owner.scopes(f.bundle.id), captured);
  } finally {
    await f.close();
  }
});

Deno.test('public journal completion survives a tenant commit crash without advancing readiness or losing a profile suffix', async () => {
  const f = await fixture();
  try {
    await f.tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
    const initial = await f.publicExport();
    assert(initial);
    assertEquals(await f.publicExport(), null);
    const journal = await f.journal();
    await journal.receive('home', [initial]);
    journal.apply = () =>
      Promise.reject(new Error('crash after public tenant commit'));
    await assertRejects(
      async () => (await f.publicOwner()).apply(journal, initial),
      Error,
      'crash after public tenant commit',
    );
    assertEquals(
      (await (await f.replicas()).scopes()).find((scope) =>
        scope.scope === initial.stream
      )?.ready,
      false,
    );
    await f.reopen();
    const owner = await f.publicOwner();
    assert(await owner.apply(await f.journal(), initial));
    assertEquals(
      (await (await f.replicas()).scopes()).find((scope) =>
        scope.scope === initial.stream
      )?.ready,
      true,
    );
    await f.tenant.tx((tx) =>
      tx.profiles.set('alice', 'displayname', 'Updated Alice')
    );
    const suffix = await f.publicExport();
    assert(suffix);
    assert(suffix.sequence > initial.sequence);
    await (await f.journal()).receive('home', [suffix]);
    assert(await owner.apply(await f.journal(), suffix));
    assertEquals(await owner.apply(await f.journal(), suffix), false);
    const bad = await new Journal(await f.home.server(), LINK_CAPABILITIES)
      .append(f.node.node, {
        ...suffix,
        operationId: 'skipped-source-cut',
        payload: { ...(suffix.payload as object), after: 999999 },
      });
    await (await f.journal()).receive('home', [bad]);
    await assertRejects(async () =>
      (await f.publicOwner()).apply(await f.journal(), bad)
    );
    assertEquals(
      (await (await f.journal()).heads('home', 'in', bad)).applied.sequence,
      suffix.sequence,
    );
  } finally {
    await f.close();
  }
});

Deno.test('a missing required room pack remains unready and cannot advance its applied cut across restart', async () => {
  const f = await fixture();
  try {
    const initial = await f.exports();
    assert(initial);
    const record = await new Journal(await f.home.server(), LINK_CAPABILITIES)
      .append('other', {
        ...initial,
        operationId: 'broken',
        payload: {
          ...initial.payload as object,
          manifest: {
            ...(initial.payload as { manifest: object }).manifest,
            events: [],
          },
        },
      });
    await (await f.journal()).receive('home', [record]);
    await assertRejects(async () =>
      (await f.replicas()).apply(await f.journal(), record)
    );
    await f.reopen();
    assertEquals(
      (await (await f.journal()).heads('home', 'in', record)).applied.sequence,
      0,
    );
    assertEquals(
      (await (await f.replicas()).status(f.source.roomId))?.ready,
      false,
    );
  } finally {
    await f.close();
  }
});

Deno.test('directory replicas preserve home alias/publication/policy intent and complete known scope inventory independently of room readiness', async () => {
  const f = await fixture();
  try {
    await f.tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
    const db = await f.home.server();
    const alias = '#replicated:logical.test';
    await registerAlias(db, alias, f.source.roomId, '@alice:logical.test');
    await setVisibility(db, f.source.roomId, 'public');
    await addPeer(db, {
      name: 'remote.test',
      host: 'peer.example',
      port: 8449,
      trust: 'pinned',
      pin: 'f'.repeat(64),
      addedBy: 'operator',
      note: 'not a public policy fact',
    });
    await addBlock(db, '*.blocked.test', 'private operator annotation');
    const owner = await f.directoryOwner();
    await assertRejects(
      () => owner.requireScope('room:' + f.source.roomId),
      MatrixError,
      'replica unavailable',
    );
    const initial = await f.directoryExport();
    assert(initial);
    assertEquals(await f.directoryExport(), null);
    const j = await f.journal();
    await j.receive('home', [initial]);
    assert(await owner.apply(j, initial));
    assertEquals(await owner.apply(j, initial), false);
    const replica = await f.edgeServer();
    assertEquals(await lookupAlias(replica, alias), f.source.roomId);
    assertEquals(await listedRooms(replica), [f.source.roomId]);
    assertEquals(
      (await listPeers(replica)).map((
        p,
      ) => [
        p.name,
        p.host,
        p.port,
        p.trust,
        p.pin_spki_sha256,
        p.added_by,
        p.note,
      ]),
      [[
        'remote.test',
        'peer.example',
        8449,
        'pinned',
        'f'.repeat(64),
        'operator',
        null,
      ]],
    );
    assert(await isBlocked(replica, 'a.blocked.test'));
    assert(
      !JSON.stringify(initial.payload).includes('private operator annotation'),
    );
    assert(
      !JSON.stringify(initial.payload).includes('not a public policy fact'),
    );
    assertEquals((await owner.snapshot())?.users, ['@alice:logical.test']);
    assertEquals((await owner.snapshot())?.rooms, [f.source.roomId]);
    await assertRejects(
      () => owner.requireScope('room:' + f.source.roomId),
      MatrixError,
      'replica unavailable',
    );
    await assertRejects(
      () => owner.requireScope('public:@alice:logical.test'),
      MatrixError,
      'replica unavailable',
    );
    const missing = await assertRejects(
      () => owner.requireScope('room:!absent:logical.test'),
      MatrixError,
    );
    assertEquals(missing.status, 404);
    const room = await f.exports();
    assert(room);
    await j.receive('home', [room]);
    assert(await (await f.replicas()).apply(j, room));
    await owner.requireScope('room:' + f.source.roomId);
    const user = await f.publicExport();
    assert(user);
    await j.receive('home', [user]);
    assert(await (await f.publicOwner()).apply(j, user));
    await owner.requireScope('public:@alice:logical.test');
    await removeAlias(db, alias);
    await setVisibility(db, f.source.roomId, 'private');
    await removePeer(db, 'remote.test');
    await removeBlock(db, '*.blocked.test');
    const suffix = await f.directoryExport();
    assert(suffix);
    await j.receive('home', [suffix]);
    await f.reopen();
    assert(await (await f.directoryOwner()).apply(await f.journal(), suffix));
    const reopened = await f.edgeServer();
    assertEquals(await lookupAlias(reopened, alias), null);
    assertEquals(await listedRooms(reopened), []);
    assertEquals(await listPeers(reopened), []);
    assertEquals(await isBlocked(reopened, 'a.blocked.test'), false);
    assertEquals(
      (await (await f.journal()).heads('home', 'in', suffix)).applied.sequence,
      2,
    );
  } finally {
    await f.close();
  }
});

Deno.test('replica admission consumes home federation mode and blocking key decisions rather than node-local defaults', async () => {
  const f = await fixture();
  try {
    const db = await f.home.server();
    await addPeer(db, {
      name: 'paused.test',
      host: null,
      port: null,
      trust: 'ca',
      addedBy: 'operator',
    });
    await db.execute(
      "INSERT INTO server_key_changes(server_name,seen_ms,old_keys,new_keys,status,acknowledged_old) VALUES('paused.test',1,'{}','{}','blocking',0)",
    );
    setConfigForTests({
      federation: {
        enabled: true,
        mode: 'closed',
        keychange: 'block',
        witnesses: 2,
      },
    });
    const record = await f.directoryExport();
    assert(record);
    const journal = await f.journal();
    await journal.receive('home', [record]);
    assert(await (await f.directoryOwner()).apply(journal, record));
    setConfigForTests({
      server: { role: 'facade' },
      federation: { mode: 'open', keychange: 'accept', witnesses: 0 },
    });
    const edge = await f.edgeServer();
    assertEquals((await federationPolicy(edge)).keychange, 'block');
    assertEquals((await federationPolicy(edge)).witnesses, 2);
    const stranger = await assertRejects(
      () => admit(edge, 'stranger.test', { kind: 'lookup', what: 'test' }),
      MatrixError,
    );
    assertEquals(stranger.status, 403);
    const blocked = await assertRejects(
      () => admit(edge, 'paused.test', { kind: 'lookup', what: 'test' }),
      MatrixError,
    );
    assertEquals(blocked.status, 403);
    setConfigForTests({
      federation: {
        enabled: true,
        mode: 'open',
        keychange: 'warn',
        witnesses: 3,
      },
    });
    await db.execute(
      "UPDATE server_key_changes SET status='noted' WHERE server_name='paused.test'",
    );
    const updated = await f.directoryExport();
    assert(updated);
    await journal.receive('home', [updated]);
    assert(await (await f.directoryOwner()).apply(journal, updated));
    await f.reopen();
    setConfigForTests({
      server: { role: 'facade' },
      federation: { mode: 'closed', keychange: 'block', witnesses: 0 },
    });
    const reopened = await f.edgeServer();
    assertEquals(
      await admit(reopened, 'stranger.test', { kind: 'lookup', what: 'test' }),
      'ok',
    );
    assertEquals(
      await admit(reopened, 'paused.test', { kind: 'lookup', what: 'test' }),
      'ok',
    );
    assertEquals((await federationPolicy(reopened)).keychange, 'warn');
  } finally {
    setConfigForTests({});
    await f.close();
  }
});

Deno.test('home reviewed remote keys reconcile facade blocks and refusal memory without clearing unrelated decisions', async () => {
  const f = await fixture();
  try {
    setConfigForTests({ federation: { keychange: 'block' } });
    const home = await f.home.server(), edge = await f.edgeServer();
    const remote = await makeServer('reviewed.test');
    const unrelated = await makeServer('unreviewed.test');
    const rotated = await makeDoc(remote, {
      kp: (await makeServer('rotation.test')).kp,
      keyId: 'ed25519:rotated',
    });
    const other = await makeDoc(unrelated, {
      kp: (await makeServer('other-rotation.test')).kp,
      keyId: 'ed25519:rotated',
    });
    for (const db of [home, edge]) {
      await seedServer(db, remote);
      await seedServer(db, unrelated);
    }
    const horizon = Date.now() + 25 * 3600000;
    const source = keyStore(home, { deps: directOnly(rotated) });
    const counter = { calls: 0 };
    const replica = keyStore(edge, { deps: directOnly(rotated, counter) });
    await assertRejects(() => source.acquireKeyDoc(remote.name, horizon));
    await assertRejects(() => replica.acquireKeyDoc(remote.name, horizon));
    await assertRejects(() =>
      keyStore(edge, { deps: directOnly(other) })
        .acquireKeyDoc(unrelated.name, horizon)
    );
    assert(await source.acceptKeyChange(remote.name));
    const record = await f.directoryExport();
    assert(record);
    const journal = await f.journal();
    await journal.receive('home', [record]);
    assert(await (await f.directoryOwner()).apply(journal, record));
    assertEquals(
      await admit(edge, remote.name, { kind: 'lookup', what: 'review' }),
      'ok',
    );
    await replica.getVerifyKey(
      remote.name,
      'ed25519:rotated',
      Date.now(),
      'request',
    );
    assertEquals(await replica.acquireKeyDoc(remote.name, Date.now()), rotated);
    assertEquals(
      counter.calls,
      1,
      'reviewed material is available without another origin dial',
    );
    await assertRejects(
      () => admit(edge, unrelated.name, { kind: 'lookup', what: 'review' }),
      MatrixError,
    );
    assert(
      (await replica.listKeyChanges(unrelated.name)).some((row) =>
        row.status === 'blocking'
      ),
    );
    await f.reopen();
    assertEquals(
      await admit(await f.edgeServer(), remote.name, {
        kind: 'lookup',
        what: 'review',
      }),
      'ok',
    );
  } finally {
    setConfigForTests({});
    await f.close();
  }
});

Deno.test('directory application rolls back domain facts, readiness and journal result together on a failed server commit', async () => {
  const f = await fixture();
  try {
    await registerAlias(
      await f.home.server(),
      '#atomic:logical.test',
      f.source.roomId,
      '@alice:logical.test',
    );
    const record = await f.directoryExport();
    assert(record);
    const journal = await f.journal();
    await journal.receive('home', [record]);
    const apply = journal.apply.bind(journal);
    journal.apply = (peer, stream, callback) =>
      apply(peer, stream, async (conn, current) => {
        await callback(conn, current);
        throw new Error('crash before directory commit');
      });
    await assertRejects(
      async () => (await f.directoryOwner()).apply(journal, record),
      Error,
      'crash before directory commit',
    );
    assertEquals(
      await lookupAlias(await f.edgeServer(), '#atomic:logical.test'),
      null,
    );
    assertEquals(await (await f.directoryOwner()).snapshot(), null);
    assertEquals(
      (await journal.heads('home', 'in', record)).applied.sequence,
      0,
    );
    await f.reopen();
    assert(await (await f.directoryOwner()).apply(await f.journal(), record));
    assertEquals(
      await lookupAlias(await f.edgeServer(), '#atomic:logical.test'),
      f.source.roomId,
    );
    await f.retire();
    await assertRejects(async () =>
      (await f.directoryOwner()).requireScope('room:' + f.source.roomId)
    );
  } finally {
    await f.close();
  }
});

Deno.test('directory readiness requires the advertised room cut, not just an older ready bootstrap', async () => {
  const f = await fixture();
  try {
    const firstRoom = await f.exports();
    assert(firstRoom);
    const journal = await f.journal();
    await journal.receive('home', [firstRoom]);
    assert(await (await f.replicas()).apply(journal, firstRoom));
    const owner = await f.directoryOwner();
    const initial = await f.directoryExport();
    assert(initial);
    await journal.receive('home', [initial]);
    assert(await owner.apply(journal, initial));
    await owner.requireScope('room:' + f.source.roomId);
    assertEquals(await owner.scopeState('room:' + f.source.roomId), 'ready');
    assertEquals(await owner.scopeState('room:!absent:logical.test'), 'absent');
    const message = await f.source.addEvent({
      type: 'm.room.message',
      content: { body: 'new inventory cut' },
    });
    await f.ingest([message]);
    const inventory = await f.directoryExport();
    assert(inventory);
    await journal.receive('home', [inventory]);
    assertEquals(await owner.snapshot(), null);
    assert(await owner.apply(journal, inventory));
    await assertRejects(
      () => owner.scopeState('room:' + f.source.roomId),
      MatrixError,
      'replica unavailable',
    );
    await assertRejects(
      () => owner.requireScope('room:' + f.source.roomId),
      MatrixError,
      'replica unavailable',
    );
    const suffix = await f.exports();
    assert(suffix);
    await journal.receive('home', [suffix]);
    assert(await (await f.replicas()).apply(journal, suffix));
    await owner.requireScope('room:' + f.source.roomId);
  } finally {
    await f.close();
  }
});

Deno.test('directory rejects foreign alias authority before changing held public facts', async () => {
  const f = await fixture();
  try {
    const initial = await f.directoryExport();
    assert(initial);
    const source = new Journal(await f.home.server(), LINK_CAPABILITIES);
    const view =
      (initial.payload as { view: { directory: { aliases: unknown[] } } }).view;
    const badAlias = await source.append('other', {
      ...initial,
      operationId: 'foreign-alias',
      payload: {
        kind: 'directory-replica',
        after: 0,
        cut: 1,
        view: {
          ...view,
          directory: {
            ...view.directory,
            aliases: [{
              alias: '#stolen:foreign.test',
              roomId: f.source.roomId,
              creator: null,
            }],
          },
        },
      },
    });
    const journal = await f.journal();
    await journal.receive('home', [badAlias]);
    await assertRejects(
      async () => (await f.directoryOwner()).apply(journal, badAlias),
      MatrixError,
      'invalid public directory facts',
    );
    assertEquals(
      (await journal.heads('home', 'in', badAlias)).applied.sequence,
      0,
    );
    assertEquals(await (await f.directoryOwner()).snapshot(), null);
  } finally {
    await f.close();
  }
});

Deno.test('directory rejects a skipped source cut despite its valid link hash', async () => {
  const f = await fixture();
  try {
    const initial = await f.directoryExport();
    assert(initial);
    const skipped = await new Journal(await f.home.server(), LINK_CAPABILITIES)
      .append('other', {
        ...initial,
        operationId: 'skipped-directory-cut',
        payload: { ...(initial.payload as object), after: 2, cut: 3 },
      });
    const journal = await f.journal();
    await journal.receive('home', [skipped]);
    await assertRejects(
      async () => (await f.directoryOwner()).apply(journal, skipped),
      Error,
      'directory source cut diverged',
    );
    assertEquals(
      (await journal.heads('home', 'in', skipped)).applied.sequence,
      0,
    );
    assertEquals(await (await f.directoryOwner()).snapshot(), null);
  } finally {
    await f.close();
  }
});

Deno.test('a received newer user scope is unavailable rather than absent before its inventory or public view applies', async () => {
  const f = await fixture();
  try {
    const initial = await f.directoryExport();
    assert(initial);
    const journal = await f.journal();
    await journal.receive('home', [initial]);
    const owner = await f.directoryOwner();
    assert(await owner.apply(journal, initial));
    await f.tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
    const user = await f.publicExport();
    assert(user);
    await journal.receive('home', [user]);
    const error = await assertRejects(
      () => owner.requireScope('public:@alice:logical.test'),
      MatrixError,
    );
    assertEquals(error.status, 503);
    assert(await (await f.publicOwner()).apply(journal, user));
    await owner.requireScope('public:@alice:logical.test');
  } finally {
    await f.close();
  }
});

Deno.test('replica device composition borrows the node service and binds its dispatcher before ingress', async () => {
  const f = await fixture();
  const peer = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: f.node.server,
        verify_keys: { [f.node.keyId]: { key: f.node.publicKey } },
      }),
  });
  let bound = false, stopped = false, recovered = '';
  let theDispatcher: unknown;
  let signatures = 0;
  const guardedSigner = {
    ...f.node.signer(),
    sign: () => {
      signatures++;
      return Promise.reject(new Error('guarded device request refused'));
    },
  };
  let recovery: ReturnType<typeof deviceListService> | undefined;
  const deviceLists = {
    recover: (user: string) => {
      recovered = user;
      return Promise.resolve();
    },
    start: () => {
      throw new Error('borrower must not start the owner service');
    },
    stop: () => {
      stopped = true;
      return Promise.resolve();
    },
  };
  const sender = {
    wake() {},
    contactHook: () => () => {},
    setIntentProvider() {},
    stop: () => {
      stopped = true;
      return Promise.resolve();
    },
    snapshot: () => [],
    reviewIntents: () => Promise.resolve(null),
    pruneIntents: () => Promise.resolve(null),
  };
  try {
    const inventory = await f.directoryExport();
    assert(inventory);
    const journal = await f.journal();
    await journal.receive('home', [inventory]);
    assert(await (await f.directoryOwner()).apply(journal, inventory));
    const tenant = await f.edgeTenant();
    setConfigForTests({
      server: { name: 'logical.test', role: 'facade' },
      facade: { phase: 'f2', nodeid: 'edge_a' },
    });
    const directory = await f.directoryOwner();
    const app = await openReplicaApp(f.edgeStore(), tenant, {
      requireScope: (scope, absent) => directory.requireScope(scope, absent),
      prepareRoomScope: (room, absent) =>
        directory.prepareRoomScope(room, absent),
      keys: keyStore(await f.edgeServer(), { signer: f.node.signer() }),
      signer: guardedSigner,
      keyDocument: () => Promise.reject(new Error('unused')),
      publicRooms: () => Promise.resolve(false),
      deviceLists: (edus) => {
        theDispatcher = edus;
        edus.register('m.device_list_update', () => Promise.resolve(), true);
        bound = true;
        return Promise.resolve(deviceLists);
      },
      sender: () => Promise.resolve(sender),
      ingress: (deps) => {
        assert(bound);
        assertEquals(deps.edus, theDispatcher);
        return Promise.resolve({
          stage: () => Promise.resolve(),
          receive: () => Promise.resolve({ status: 200, body: {} }),
        });
      },
    });
    // The application exposes exactly the borrowed object, not a second worker.
    assertEquals(app.deviceLists, deviceLists);
    assertEquals(app.sender, sender);
    await app.deviceLists.recover('@remote:elsewhere.test');
    assertEquals(recovered, '@remote:elsewhere.test');
    const remote = '@remote:' + peer.name;
    for (
      const request of [
        () =>
          queryKeys('@alice:logical.test', { device_keys: { [remote]: [] } }),
        () =>
          claimKeys('@alice:logical.test', {
            one_time_keys: { [remote]: { D: 'signed_curve25519' } },
          }),
      ]
    ) {
      await assertRejects(request, Error, 'guarded device request refused');
    }
    assertEquals(signatures, 2);
    assertEquals(recovered, remote);
    // Remote snapshot recovery uses the same explicit signer, never tenant's
    // raw identity. No wire request reaches the peer after authority refusal.
    await app.server.tx((tx) =>
      reconcileDeviceRoom(
        tx,
        '!devices:logical.test',
        ['@alice:logical.test', remote],
        false,
        null,
        1,
        ['logical.test'],
      )
    );
    recovery = deviceListService(
      app.server,
      tenant,
      eduState(app.server, tenant.serverName, app.store),
      guardedSigner,
    );
    await assertRejects(
      () => recovery!.recover(remote),
      Error,
      'guarded device request refused',
    );
    assertEquals(signatures, 3);
    assertEquals(peer.requests.length, 0);
    // Owner stops the real recovery service before closing its shared store.
    await recovery.stop();
    recovery = undefined;
    await closeApp();
    assertEquals(stopped, false);
  } finally {
    await recovery?.stop();
    await closeApp();
    await peer.close();
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('facade authorship captures room permits and never exposes the raw tenant signer', async () => {
  const f = await fixture();
  let allowed = true, preparations = 0, signatures = 0;
  const raw = f.node.signer();
  const guarded = {
    serverName: raw.serverName,
    keyId: raw.keyId,
    sign: () =>
      Promise.reject(
        new MatrixError(
          503,
          'M_UNAVAILABLE',
          'request signer is not a room permit',
        ),
      ),
    prepare: async () => {
      preparations++;
      // The store rejects this cross-file access if preparation happens inside
      // a room transaction. The byte signer below must not open this file.
      await (await f.edgeServer()).query('SELECT 1');
      if (!allowed) {
        throw new MatrixError(503, 'M_UNAVAILABLE', 'signing expired');
      }
      return {
        serverName: raw.serverName,
        keyId: raw.keyId,
        sign: async (bytes: string) => {
          if (!allowed) {
            throw new MatrixError(503, 'M_UNAVAILABLE', 'signing expired');
          }
          signatures++;
          return await raw.sign(bytes);
        },
      };
    },
  };
  try {
    setConfigForTests({
      server: { name: 'logical.test', role: 'facade' },
      facade: { phase: 'f2', nodeid: 'edge_a' },
    });
    const app = await openReplicaApp(f.edgeStore(), await f.edgeTenant(), {
      requireScope: () => Promise.resolve(),
      prepareRoomScope: () => Promise.reject(new Error('unused')),
      keys: keyStore(await f.edgeServer(), { signer: guarded }),
      signer: guarded,
      keyDocument: () => Promise.reject(new Error('unused')),
      publicRooms: () => Promise.resolve(false),
    });
    await assertRejects(
      () => app.tenant.signer().sign('unprepared'),
      MatrixError,
      'request signer',
    );
    const user = '@alice:logical.test';
    const created = await createClientRoom({
      creator: user,
      preset: 'public_chat',
    });
    const room = await openRoom(app.store, created.roomId);
    const joined = await localMembership.membershipOf(room, user);
    assert(joined);
    const joiningCut = { preparations, signatures };
    allowed = false;
    for (
      const retry of [
        () => localMembership.join(room, user, app.tenant.signer()),
        () => localMembership.joinResident(room, user, app.tenant.signer()),
        () => localMembership.reopen(room, user, app.tenant.signer(), {}),
      ]
    ) {
      assertEquals(await retry(), {
        roomId: room.id,
        eventId: joined.eventId,
        created: false,
      });
      assertEquals({ preparations, signatures }, joiningCut);
    }
    allowed = true;
    const message = await sendEvent(
      room.id,
      user,
      'm.room.encrypted',
      { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'opaque' },
      null,
      'send',
    );
    await writeStateKey(room.id, user, 'm.room.topic', '', { topic: 'facade' });
    await redactEvent(
      room.id,
      user,
      message.event_id,
      undefined,
      null,
      'redact',
    );
    // Hold the ordinary projection hook to model the room-commit / server-cut
    // crash window, then let the same expired-authority retry repair it.
    setRoomHooks({
      project: (store, id) =>
        store === app.store ? Promise.resolve() : project(store, id),
      register: registerRoom,
    });
    const left = await localMembership.leave(room, user, app.tenant.signer());
    assertEquals(
      (await projectedMembershipOf(app.server, room.id, user))?.membership,
      'join',
    );
    installServerHooks();
    const leavingCut = { preparations, signatures };
    allowed = false;
    assertEquals(await localMembership.leave(room, user, app.tenant.signer()), {
      ...left,
      created: false,
    });
    assertEquals({ preparations, signatures }, leavingCut);
    assertEquals(
      (await projectedMembershipOf(app.server, room.id, user))?.membership,
      'leave',
    );
    // No resident means remote routing, not a fresh local signature. This is
    // also required after a last-local departure with expired authority.
    assertEquals(
      await localMembership.joinResident(room, user, app.tenant.signer()),
      null,
    );
    assertEquals({ preparations, signatures }, leavingCut);
    allowed = true;
    await localMembership.reopen(room, user, app.tenant.signer(), {});
    let saved: PreparedSubmission | null = null;
    const submission = {
      lookup: () => Promise.resolve(saved),
      prepare: (pdu: Pdu) =>
        Promise.resolve(saved = { eventId: String(pdu.event_id), pdu }),
      finish: () => Promise.resolve(),
    };
    const partial = {
      type: 'm.room.encrypted',
      sender: user,
      content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'receipt' },
    };
    const original = await sendLocal(
      room,
      partial,
      app.tenant.signer(),
      submission,
    );
    const cut = { preparations, signatures };
    allowed = false;
    const replay = await sendLocal(
      room,
      { ...partial, content: { ciphertext: 'changed retry' } },
      app.tenant.signer(),
      submission,
    );
    assertEquals(replay.eventId, original.eventId);
    assertEquals(replay.receipt, true);
    assertEquals({ preparations, signatures }, cut);
    await assertRejects(
      () => sendLocal(room, partial, app.tenant.signer()),
      MatrixError,
      'expired',
    );
    assertEquals(signatures, cut.signatures);
    assert(preparations >= 8);
  } finally {
    installServerHooks();
    await closeApp();
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('facade create variants refuse home-owned directory writes before any room or signature', async (t) => {
  const f = await fixture();
  let signatures = 0;
  const raw = f.node.signer();
  const signer = {
    ...raw,
    sign: (bytes: string) => {
      signatures++;
      return raw.sign(bytes);
    },
  };
  try {
    setConfigForTests({
      server: { name: 'logical.test', role: 'facade' },
      facade: { phase: 'f2', nodeid: 'edge_a' },
    });
    const app = await openReplicaApp(f.edgeStore(), await f.edgeTenant(), {
      requireScope: () => Promise.resolve(),
      prepareRoomScope: () => Promise.reject(new Error('unused')),
      keys: keyStore(await f.edgeServer(), { signer }),
      signer,
      keyDocument: () => Promise.reject(new Error('unused')),
      publicRooms: () => Promise.resolve(false),
    });
    await registerAlias(
      app.server,
      '#held:logical.test',
      f.room.id,
      '@alice:logical.test',
    );
    const before = {
      rooms: await app.store.rooms(),
      aliases: await app.server.query('SELECT * FROM aliases'),
      visibility: await app.server.query('SELECT * FROM visibility'),
    };
    for (
      const variant of [
        { alias: 'fresh' },
        { alias: 'held' },
        { visibility: 'public' },
        { alias: 'fresh', visibility: 'public' },
      ]
    ) {
      await t.step(JSON.stringify(variant), async () => {
        const error = await assertRejects(
          () =>
            createClientRoom({ creator: '@alice:logical.test', ...variant }),
          MatrixError,
        );
        assertEquals(error.status, 503);
        assertEquals(error.errcode, 'M_UNAVAILABLE');
        assertEquals(signatures, 0);
        assertEquals({
          rooms: await app.store.rooms(),
          aliases: await app.server.query('SELECT * FROM aliases'),
          visibility: await app.server.query('SELECT * FROM visibility'),
        }, before);
      });
    }
    // Public join rules are room PDUs, not directory publication authority.
    const created = await createClientRoom({
      creator: '@alice:logical.test',
      preset: 'public_chat',
      visibility: 'private',
    });
    assert(await openRoom(app.store, created.roomId));
    assert(signatures > 0);
    assertEquals(await lookupAlias(app.server, '#fresh:logical.test'), null);
    assertEquals(
      await app.server.query('SELECT * FROM visibility'),
      before.visibility,
    );
  } finally {
    await closeApp();
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('replica service acquisition releases a failed composition before retrying with a new dispatcher', async () => {
  const f = await fixture();
  let dispatcher: unknown, releases = 0, attempts = 0;
  try {
    const tenant = await f.edgeTenant();
    setConfigForTests({
      server: { name: 'logical.test', role: 'facade' },
      facade: { phase: 'f2', nodeid: 'edge_a' },
    });
    const service = {
      recover: () => Promise.resolve(),
      start() {},
      stop: () => Promise.resolve(),
    };
    const access = {
      requireScope: () => Promise.resolve(),
      prepareRoomScope: () => Promise.reject(new Error('unused')),
      keys: keyStore(await f.edgeServer(), { signer: f.node.signer() }),
      signer: f.node.signer(),
      keyDocument: () => Promise.reject(new Error('unused')),
      publicRooms: () => Promise.resolve(false),
      deviceLists: (edus: ReturnType<typeof eduState>) => {
        if (dispatcher && dispatcher !== edus) {
          throw new Error('old dispatcher retained');
        }
        dispatcher = edus;
        return Promise.resolve(service);
      },
      ingress: () => {
        if (++attempts === 1) {
          return Promise.reject(new Error('composition interrupted'));
        }
        return Promise.resolve({
          stage: () => Promise.resolve(),
          receive: () => Promise.resolve({ status: 200, body: {} }),
        });
      },
      releaseServices: async () => {
        await service.stop();
        dispatcher = undefined;
        releases++;
      },
    };
    await assertRejects(
      () => openReplicaApp(f.edgeStore(), tenant, access),
      Error,
      'composition interrupted',
    );
    assertEquals(
      releases,
      1,
      'runtime owner must release services after failed acquisition',
    );
    const app = await openReplicaApp(f.edgeStore(), tenant, access);
    assertEquals(app.deviceLists, service);
    assertEquals(attempts, 2);
    await closeApp();
    assertEquals(
      releases,
      1,
      'borrower does not stop successfully acquired owner services',
    );
  } finally {
    await closeApp();
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('enrolled replica app composes ordinary reads and recovery without creating home-only workers or a home identity', async () => {
  const f = await fixture();
  try {
    const record = await f.exports();
    assert(record);
    const journal = await f.journal();
    await journal.receive('home', [record]);
    assert(await (await f.replicas()).apply(journal, record));
    const inventory = await f.directoryExport();
    assert(inventory);
    await journal.receive('home', [inventory]);
    assert(await (await f.directoryOwner()).apply(journal, inventory));
    const tenant = await f.edgeTenant();
    setConfigForTests({
      server: { name: 'logical.test', role: 'facade' },
      facade: { nodeid: 'edge_a' },
    });
    const directory = await f.directoryOwner();
    const app = await openReplicaApp(f.edgeStore(), tenant, {
      requireScope: (scope, allowAbsent) =>
        directory.requireScope(scope, allowAbsent),
      prepareRoomScope: (roomId, allowAbsent) =>
        directory.prepareRoomScope(roomId, allowAbsent),
      keys: keyStore(await f.edgeServer(), { signer: f.node.signer() }),
      signer: f.node.signer(),
      keyDocument: () =>
        Promise.reject(
          new Error('key document is supplied by the enrolled owner'),
        ),
      publicRooms: async () => (await directory.snapshot())!.publicRooms,
    });
    assertEquals(theApp(), app);
    assertEquals(app.tenant.keyId, f.node.keyId);
    assertEquals(app.sender, null);
    for (
      const service of [
        'pushSender',
        'delayedEvents',
        'media',
        'deviceLists',
      ] as const
    ) {
      const error = assertThrows(() => app[service], MatrixError);
      assertEquals(error.status, 503);
    }
    assertThrows(() => startFederationServices(app), MatrixError);
    const eventId = String([...f.source.events.values()].at(-1)!.event_id);
    assertEquals(await roomOf(app.server, eventId), f.source.roomId);
    const served = await serveEvent(eventId, f.signing.name, serveDeps());
    assertEquals(served.origin, f.tenant.serverName);
    assertEquals(served.pdus[0].content, f.source.events.get(eventId)!.content);
    const homeDeps = {
      store: f.home,
      server: await f.home.server(),
      self: f.tenant.serverName,
    };
    const origin = f.signing.name, roomId = f.source.roomId;
    const readers = [
      (deps: serving.ServeDeps) =>
        serving.serveState(roomId, eventId, origin, deps),
      (deps: serving.ServeDeps) =>
        serving.serveStateIds(roomId, eventId, origin, deps),
      (deps: serving.ServeDeps) =>
        serving.serveEventAuth(roomId, eventId, origin, deps),
      (deps: serving.ServeDeps) =>
        serving.serveBackfill(roomId, [eventId], 10, origin, deps),
      (deps: serving.ServeDeps) =>
        serving.serveGetMissingEvents(
          roomId,
          { earliest_events: [], latest_events: [eventId], limit: 10 },
          origin,
          deps,
        ),
      (deps: serving.ServeDeps) =>
        serving.serveTimestamp(roomId, { ts: 0, dir: 'f' }, origin, deps),
    ];
    const semantic = (value: unknown) => {
      const out = { ...value as Record<string, unknown> };
      delete out.origin_server_ts;
      return out;
    };
    for (const read of readers) {
      assertEquals(
        semantic(await read(serveDeps())),
        semantic(await read(homeDeps)),
      );
    }
    const next = await f.source.addEvent({
      type: 'm.room.message',
      content: { body: 'not applied yet' },
    });
    await f.ingest([next]);
    const suffix = await f.exports();
    assert(suffix);
    await journal.receive('home', [suffix]);
    for (const read of readers) {
      const unavailable = await assertRejects(
        () => read(serveDeps()),
        MatrixError,
      );
      assertEquals(unavailable.status, 503);
    }
    const unknown = await assertRejects(
      () => serveEvent('$unknown', origin, serveDeps()),
      MatrixError,
    );
    assertEquals(unknown.status, 503);
    assert(await (await f.replicas()).apply(journal, suffix));
    assertEquals(
      (await serveEvent(String(next.event_id), origin, serveDeps())).pdus[0]
        .content,
      next.content,
    );
    const absent = await assertRejects(
      () => serveEvent('$unknown', origin, serveDeps()),
      MatrixError,
    );
    assertEquals(absent.status, 404);
    await assertRejects(
      () => openReplicaApp(f.edgeStore(), tenant, app.replica!),
      Error,
      'already open',
    );
    await closeApp();
    assertThrows(() => theApp(), Error, 'no app open');
  } finally {
    await closeApp();
    setConfigForTests({});
    await f.close();
  }
});

Deno.test('receipt scope: a suffix after preparation refuses all client receipt kinds without effects', async (t) => {
  for (const kind of ['m.read', 'm.read.private', 'm.fully_read'] as const) {
    await t.step(kind, async () => {
      const f = await fixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let holdPrepared = false;
      let writing: Promise<void> | undefined;
      try {
        const initial = await f.exports();
        assert(initial);
        const journal = await f.journal();
        await journal.receive('home', [initial]);
        assert(await (await f.replicas()).apply(journal, initial));
        const inventory = await f.directoryExport();
        assert(inventory);
        await journal.receive('home', [inventory]);
        assert(await (await f.directoryOwner()).apply(journal, inventory));
        const tenant = await f.edgeTenant();
        await tenant.tx((tx) => tx.users.insert('zoe', 'Zoe'));
        setConfigForTests({
          server: { name: 'logical.test', role: 'facade' },
          facade: { nodeid: 'edge_a' },
        });
        const directory = await f.directoryOwner();
        const app = await openReplicaApp(f.edgeStore(), tenant, {
          requireScope: (scope, allowAbsent) =>
            directory.requireScope(scope, allowAbsent),
          prepareRoomScope: async (roomId, allowAbsent) => {
            const admission = await directory.prepareRoomScope(
              roomId,
              allowAbsent,
            );
            if (holdPrepared) {
              entered.resolve();
              await release.promise;
            }
            return admission;
          },
          keys: keyStore(await f.edgeServer(), { signer: f.node.signer() }),
          signer: f.node.signer(),
          keyDocument: () => Promise.reject(new Error('unused')),
          publicRooms: async () => (await directory.snapshot())!.publicRooms,
        });
        const eventId = String([...f.source.events.values()].at(-1)!.event_id);
        if (kind !== 'm.fully_read') {
          await app.server.execute(
            "INSERT INTO facade_owner_activation VALUES('receipt-noop',1,'verified-test')",
          );
          // The production client adapter must acknowledge an admitted graph
          // no-op, not convert the unchanged projection into M_FORBIDDEN.
          for (let n = 0; n < 2; n++) {
            await writeClientReceipt(
              f.source.roomId,
              f.source.creator,
              kind,
              eventId,
            );
          }
        }
        const before = await app.server.query('SELECT * FROM receipts');
        holdPrepared = true;
        writing = writeClientReceipt(
          f.source.roomId,
          f.source.creator,
          kind,
          eventId,
        );
        await entered.promise;
        const next = await f.source.addEvent({
          type: 'm.room.message',
          content: { body: 'pending suffix' },
        });
        await f.ingest([next]);
        const suffix = await f.exports();
        assert(suffix);
        await journal.receive('home', [suffix]);
        await assertRejects(
          () => directory.requireScope('room:' + f.source.roomId),
          MatrixError,
        );
        release.resolve();
        await assertRejects(() => writing!, MatrixError, 'replica unavailable');
        assertEquals(await app.server.query('SELECT * FROM receipts'), before);
        assertEquals(
          await tenant.tx((tx) =>
            tx.accountData.get('zoe', f.source.roomId, 'm.fully_read')
          ),
          null,
        );
      } finally {
        release.resolve();
        await writing?.catch(() => {});
        await closeApp();
        setConfigForTests({});
        await f.close();
      }
    });
  }
});

Deno.test('directory and peer policy exports use the published server cut without reopening busy or unavailable room files', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held: Promise<void> | undefined;
  let exporting: ReturnType<typeof exportDirectoryReplica> | undefined;
  const room = f.home.room.bind(f.home);
  try {
    const initial = await f.directoryExport();
    assert(initial);
    held = f.room.tx(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    f.home.room = () =>
      Promise.reject(new Error('room metadata temporarily unavailable'));
    await registerAlias(
      await f.home.server(),
      '#fair:logical.test',
      f.source.roomId,
      '@alice:logical.test',
    );
    exporting = exportDirectoryReplica(
      f.home,
      f.tenant,
      f.node.node,
      f.bundle.id,
    );
    const record = await bounded(exporting);
    assert(record);
    const journal = await f.journal();
    // Deliver the first manifest before its successor, exactly as the link does.
    await journal.receive('home', [initial, record]);
    const owner = await f.directoryOwner();
    assert(await owner.apply(journal, initial));
    assert(await owner.apply(journal, record));
    assertEquals(
      await lookupAlias(await f.edgeServer(), '#fair:logical.test'),
      f.source.roomId,
    );
  } finally {
    release.resolve();
    await held;
    f.home.room = room;
    await exporting?.catch(() => undefined);
    await f.close();
  }
});

Deno.test('real replica HTTP reads distinguish required cuts from absence and bind home directory policy', async () => {
  const f = await fixture();
  let http: Deno.HttpServer<Deno.NetAddr> | undefined;
  setConfigForTests({
    server: { name: 'logical.test' },
    federation: { enabled: true, mode: 'open', publicrooms: false },
  });
  try {
    await f.tenant.tx(async (tx) => {
      await tx.users.insert('alice', 'Alice');
      await tx.profiles.set('alice', 'displayname', 'Linked Alice');
    });
    await registerAlias(
      await f.home.server(),
      '#linked:logical.test',
      f.source.roomId,
      '@alice:logical.test',
    );
    await setVisibility(await f.home.server(), f.source.roomId, 'public');
    const inventory = await f.directoryExport();
    assert(inventory);
    const journal = await f.journal(), directory = await f.directoryOwner();
    await journal.receive('home', [inventory]);
    assert(await directory.apply(journal, inventory));
    await seedServer(await f.edgeServer(), f.signing);
    setConfigForTests({
      server: { name: 'logical.test', role: 'facade' },
      federation: { enabled: true, mode: 'closed', publicrooms: true },
    });
    await openReplicaApp(f.edgeStore(), await f.edgeTenant(), {
      requireScope: (scope, allowAbsent) =>
        directory.requireScope(scope, allowAbsent),
      prepareRoomScope: (roomId, allowAbsent) =>
        directory.prepareRoomScope(roomId, allowAbsent),
      keyDocument: () =>
        Promise.reject(new Error('unused key-document callback')),
      keys: keyStore(await f.edgeServer(), { signer: f.node.signer() }),
      signer: f.node.signer(),
      publicRooms: async () => (await directory.snapshot())!.publicRooms,
    });
    http = Deno.serve(
      { hostname: '127.0.0.1', port: 0, onListen: () => {} },
      await pathfinder({ roots: ['api/endpoints/matrix/'] }),
    );
    const base = `http://127.0.0.1:${http.addr.port}`;
    const call = fedCaller((request) => {
      const url = new URL(request.url);
      return fetch(new Request(base + url.pathname + url.search, request));
    }, f.signing);
    const p = '/_matrix/federation/v1/';
    const alias = p + 'query/directory?room_alias=' +
      encodeURIComponent('#linked:logical.test');
    const profile = p + 'query/profile?user_id=' +
      encodeURIComponent('@alice:logical.test');
    const devices = p + 'user/devices/' +
      encodeURIComponent('@alice:logical.test');
    const query = { device_keys: { '@alice:logical.test': [] } };
    for (const path of [alias, profile, devices]) {
      assertEquals((await call('GET', path)).status, 503);
    }
    assertEquals(
      (await call('POST', p + 'user/keys/query', query)).status,
      503,
    );
    assertEquals((await call('GET', p + 'publicRooms')).status, 403);
    assertEquals(
      (await call('POST', p + 'user/keys/query', {
        device_keys: { '@absent:logical.test': [] },
      })).status,
      200,
    );
    assertEquals(
      (await call(
        'GET',
        p + 'query/profile?user_id=' +
          encodeURIComponent('@absent:logical.test'),
      )).status,
      404,
    );
    const room = await f.exports(), user = await f.publicExport();
    assert(room && user);
    await journal.receive('home', [room]);
    await journal.receive('home', [user]);
    assert(await (await f.replicas()).apply(journal, room));
    assert(await (await f.publicOwner()).apply(journal, user));
    assertEquals(await call('GET', alias), {
      status: 200,
      body: { room_id: f.source.roomId, servers: ['logical.test'] },
    });
    assertEquals(await call('GET', profile), {
      status: 200,
      body: { displayname: 'Linked Alice' },
    });
    assertEquals((await call('GET', devices)).status, 200);
    assertEquals(
      (await call('POST', p + 'user/keys/query', query)).status,
      200,
    );
    setConfigForTests({
      server: { name: 'logical.test' },
      federation: { enabled: true, mode: 'open', publicrooms: true },
    });
    const next = await f.directoryExport();
    assert(next);
    await journal.receive('home', [next]);
    assertEquals((await call('GET', profile)).status, 503);
    assert(await directory.apply(journal, next));
    setConfigForTests({
      server: { name: 'logical.test', role: 'facade' },
      federation: { enabled: true, publicrooms: false },
    });
    const published = await call('GET', p + 'publicRooms');
    assertEquals(published.status, 200);
    assertEquals(
      (published.body.chunk as { room_id: string }[]).map((room) =>
        room.room_id
      ),
      [f.source.roomId],
    );
  } finally {
    await http?.shutdown();
    await closeApp();
    setConfigForTests({});
    await f.close();
  }
});
