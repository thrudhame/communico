import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  closeApp,
  openReplicaApp,
  startFederationServices,
  theApp,
} from '#engine/app.ts';
import { setConfigForTests } from '#engine/config.ts';
import { claimKeys, queryKeys } from '#engine/client/e2ee.ts';
import { canSeeEvent } from '#engine/client/visibility.ts';
import { join as clientJoin, joinedRooms } from '#engine/client/membership.ts';
import {
  getVisibility,
  listLocalPublishedRooms,
  resolveAlias,
  roomAliases,
  searchUsers,
} from '#engine/client/directory.ts';
import { versionOf } from '#engine/client/room.ts';
import { roomEvents, roomInitialSync } from '#engine/client/peeking.ts';
import { formatStreamToken } from '#engine/client/tokens.ts';
import { publicationIdentity } from '#engine/facade/ownership.ts';
import { setTyping, typingIn } from '#engine/typing.ts';
import {
  createRoom as createClientRoom,
  inviteDeps,
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
import { ReplicaReadiness } from '#engine/facade/readiness.ts';
import { admit } from '#engine/federation/gate.ts';
import { federationPolicy } from '#engine/federation/policy.ts';
import { keyStore } from '#engine/federation/keys.ts';
import { inviteDependencies } from '#engine/federation/dependencies.ts';
import { productionKeyResolver } from '#engine/federation/keyresolver.ts';
import { exportKeyRoster, FacadeKeys } from '#engine/facade/control.ts';
import { exportAccountAuth } from '#engine/facade/accounts.ts';
import { MembershipOperations } from '#engine/facade/membership.ts';
import { exportOwnerControl, OwnerControls } from '#engine/facade/ownership.ts';
import { startInboxWorker } from '#engine/facade/worker.ts';
import { JournalClient } from '#engine/facade/client.ts';
import { LinkClient } from '#engine/facade/transport.ts';
import * as serving from '#engine/federation/serve.ts';
import {
  type Context,
  pathfinder,
  type PathfinderRequest,
} from '@pathfinder/pathfinder';
import {
  directOnly,
  makeDoc,
  makeServer,
  seedServer,
} from './federation/doc-helper.ts';
import { fedCaller, signTemplate } from './http-federation.ts';
import {
  certificatePin,
  enrolledTenant,
  initializeNode,
} from '#engine/facade/identity.ts';
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
import {
  joinedUsers,
  listedRooms,
  setVisibility,
} from '#engine/server/directory.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { setReceipt as writeClientReceipt } from '#engine/receipts.ts';
import { appendRecord, Journal } from '#engine/facade/journal.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import {
  LINK_CAPABILITIES,
  LINK_SUPPORTED,
  LinkError,
} from '#engine/facade/protocol.ts';
import { applyReplicaScope } from '#engine/facade/scopes.ts';
import { replicationProgress } from '#engine/facade/progress.ts';
import type { Database } from '#engine/store/db.ts';
import {
  exportRoomReplica,
  RoomReplicas,
  startRoomExports,
} from '#engine/facade/replication.ts';
import { bounded } from './helpers/server-process.ts';
import type { Pdu } from '#engine/pdu.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { restrictedKnowledge, setRoomHooks } from '#engine/room/hooks.ts';
import {
  importReplicaBoundary,
  importReplicaGenesis,
} from '#engine/room/replica.ts';
import { importReplicaRoom } from '#engine/room/replica-import.ts';
import { contentHashMatches } from '#engine/room/verify.ts';
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
import { directoryFactsOf } from '#engine/server/public-replica.ts';
import { project } from '#engine/server/project.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
} from './fixtures/remote.ts';
import { makeFakeRoom } from './fixtures/remote-room.ts';
import { createRoom } from '#engine/room/create.ts';
import {
  applicationScope,
  facadeFailure,
  FacadeObservations,
  facadeProcess,
} from './helpers/facade-process.ts';
import { facadeTls } from './support/facade-tls.ts';
import { object, recordHash } from '#engine/facade/protocol.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { getPresence } from '#engine/client/presence.ts';
import { setPresence } from '#engine/server/ephemeral.ts';
import {
  clientHierarchy,
  federationHierarchy,
  hierarchyQuery,
} from '#engine/client/hierarchy.ts';
import {
  b64decode,
  importPublicKeyFromRaw,
} from '#engine/signing-primitives.js';

async function fixture(
  seedServer = serverSchema,
  version = '11',
  facadePin = 'b'.repeat(64),
  homePin = 'a'.repeat(64),
) {
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
    homePin,
  );
  const edgePairings = async () =>
    new Pairings(
      await edge.server(),
      node.signer(),
      node.publicKey,
      facadePin,
      node,
    );
  const fp = await edgePairings();
  const bundle = await hp.create({
    node: node.node,
    url: 'https://facade.test',
    facadePin,
    expires: Date.now() + 60000,
    required: [...LINK_CAPABILITIES],
  });
  await fp.accept(bundle);
  const grant = await hp.grant(
    bundle.id,
    await fp.challenge(bundle.id, bundle.secret, homePin),
  );
  await hp.confirm(
    bundle.id,
    await fp.complete(bundle.id, grant, homePin),
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
    dir,
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

Deno.test('operator replication progress distinguishes exact source, publication, receipt and application cuts without writing', async () => {
  const f = await fixture();
  const scope = 'room:' + f.room.id;
  const readHome = () =>
    replicationProgress(f.home, f.tenant.serverName, 'home', [scope]);
  const readEdge = () =>
    replicationProgress(f.edgeStore(), f.tenant.serverName, 'facade', [scope]);
  try {
    const original = await f.room.tx((tx) => tx.changes.head());
    assertEquals((await readHome()).sources, [{ scope, cut: original }]);
    const record = (await f.exports())!;
    const published = (await readHome()).streams[0];
    assertEquals(published.published, {
      sequence: record.sequence,
      hash: record.hash,
      sourceCut: original,
    });
    assertEquals(published.received, {
      sequence: 0,
      hash: '',
      sourceCut: null,
    });
    const journal = await f.journal();
    await journal.receive('home', [record]);
    const received = (await readEdge()).streams[0];
    assertEquals(received.received, published.published);
    assertEquals(received.applied, { sequence: 0, hash: '', sourceCut: null });
    assertEquals(received.published, null);
    assert(await (await f.replicas()).apply(journal, record));
    const applied = (await readEdge()).streams[0];
    assertEquals(applied.applied, published.published);
    assertEquals(applied.published, published.published);
    assertEquals(applied.ready, true);
    assertEquals(applied.incarnation, f.bundle.id);
    assertEquals(applied.source, 'home');
    const next = await f.source.addEvent({
      type: 'm.room.message',
      content: { body: 'private-body-never-in-status' },
    });
    await f.ingest([next]);
    const target = (await readHome()).sources[0].cut;
    assert(target > original);
    assertEquals((await readEdge()).streams[0].applied, applied.applied);
    // Status does not mint snapshots or move any durable export/application cut.
    const before = await (await f.home.server()).query(
      'SELECT * FROM facade_exports',
    );
    const first = await readHome();
    assertEquals(await readHome(), first);
    assertEquals(
      await (await f.home.server()).query('SELECT * FROM facade_exports'),
      before,
    );
    assert(!JSON.stringify(first).includes('private-body-never-in-status'));
    assertEquals(
      (await replicationProgress(f.home, f.tenant.serverName, 'home', [
        'room:!missing:logical.test',
      ])).sources,
      [],
    );
    const replica = await f.replica();
    assertEquals((await readEdge()).sources, [{
      scope,
      cut: await replica.tx((tx) => tx.changes.head()),
    }]);
    assertEquals(
      (await replicationProgress(f.edgeStore(), f.tenant.serverName, 'facade', [
        'public:@alice:' + f.tenant.serverName,
        'room:!missing:logical.test',
      ])).sources,
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test('replica signature evidence replays hash-redacted non-create events without duplicate news', async () => {
  const f = await fixture();
  try {
    const message = await f.source.addEvent({
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: 'original retained content' },
    });
    await f.ingest([structuredClone(message)]);
    const manifest = await exportReplicaRoom(f.room, f.tenant.serverName);
    const target = manifest.events.find((pdu) =>
      pdu.event_id === message.event_id
    )!;
    target.content = { msgtype: 'm.text', body: 'hash mismatched in transit' };
    const apply = () =>
      importReplicaRoom(f.edgeStore(), structuredClone(manifest), {
        self: f.tenant.serverName,
        keys: fakeKeyResolver(f.signing),
        signatureUnion: true,
      });
    await apply();
    const replica = await f.replica();
    const before = await replica.tx(async (tx) => ({
      row: await tx.events.get(String(message.event_id)),
      head: await tx.changes.head(),
      position: await tx.segments.positionOf(String(message.event_id)),
    }));
    assertEquals(JSON.parse(before.row!.pdu).content, {});
    assert(before.position);
    await f.reopen();
    await apply();
    const after = await (await f.replica()).tx(async (tx) => ({
      row: await tx.events.get(String(message.event_id)),
      head: await tx.changes.head(),
      position: await tx.segments.positionOf(String(message.event_id)),
    }));
    assertEquals(after, before);
    // A peer may retain the authentic full form while this replica retained
    // hash-redacted bytes. Its signatures can be learned without rewriting us.
    target.content = structuredClone(message.content);
    await apply();
    assertEquals(
      await (await f.replica()).tx((tx) =>
        tx.events.get(String(message.event_id))
      ),
      before.row,
    );
    assertEquals(
      await (await f.replica()).tx((tx) => tx.changes.head()),
      before.head,
    );
  } finally {
    await f.close();
  }
});

Deno.test('replica signature replay retains provenance when redaction restores the advertised content hash', async () => {
  const f = await fixture();
  try {
    const message = await f.source.addEvent({
      type: 'm.room.message',
      content: {},
    });
    await f.ingest([structuredClone(message)]);
    const manifest = await exportReplicaRoom(f.room, f.tenant.serverName);
    manifest.events.find((pdu) => pdu.event_id === message.event_id)!.content =
      {
        injected: true,
      };
    const apply = () =>
      importReplicaRoom(f.edgeStore(), structuredClone(manifest), {
        self: f.tenant.serverName,
        keys: fakeKeyResolver(f.signing),
        signatureUnion: true,
      });
    await apply();
    const replica = await f.replica();
    const before = await replica.tx(async (tx) => ({
      row: await tx.events.get(String(message.event_id)),
      head: await tx.changes.head(),
      position: await tx.segments.positionOf(String(message.event_id)),
    }));
    assertEquals(JSON.parse(before.row!.pdu).content, {});
    assertEquals(await contentHashMatches(JSON.parse(before.row!.pdu)), true);
    assertEquals(
      await (await f.edgeStore().room(replica.id)).query(
        'SELECT hash_redacted FROM events WHERE id=?',
        [String(message.event_id)],
      ),
      [{ hash_redacted: 1 }],
    );
    await f.reopen();
    await apply();
    assertEquals(
      await (await f.replica()).tx(async (tx) => ({
        row: await tx.events.get(String(message.event_id)),
        head: await tx.changes.head(),
        position: await tx.segments.positionOf(String(message.event_id)),
      })),
      before,
    );
  } finally {
    await f.close();
  }
});

Deno.test('replica signature evidence omits invalid optional entries admitted by ordinary ingress', async () => {
  const f = await fixture();
  try {
    const witness = await makeRemoteServer('optional.test');
    const message = await f.source.addEvent({
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: 'required sender is valid' },
    });
    message.signatures![witness.name] = { [witness.keyId]: 'A'.repeat(86) };
    await f.ingest([structuredClone(message)]);
    const retained = await f.room.tx((tx) =>
      tx.events.get(String(message.event_id))
    );
    assert(retained);
    assertEquals(
      JSON.parse(retained.pdu).signatures[witness.name],
      message.signatures![witness.name],
    );
    const manifest = await exportReplicaRoom(f.room, f.tenant.serverName);
    await importReplicaRoom(f.edgeStore(), structuredClone(manifest), {
      self: f.tenant.serverName,
      keys: fakeKeyResolver(f.signing, witness),
      signatureUnion: true,
    });
    const replica = await f.replica();
    assertEquals(
      (await replica.tx((tx) => tx.events.getStatus(String(message.event_id))))
        ?.grounding,
      'grounded',
    );
    assertEquals(
      await (await f.edgeStore().room(replica.id)).query(
        'SELECT * FROM event_signatures WHERE event=?',
        [String(message.event_id)],
      ),
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test('replica signature receipt provenance is owned by ordinary live and snapshot admission too', async () => {
  const f = await fixture();
  try {
    const message = await f.source.addEvent({
      type: 'm.room.message',
      content: {},
    });
    const incoming = structuredClone(message);
    incoming.content = { injected: true };
    await f.ingest([incoming]);
    assertEquals(
      await (await f.home.room(f.room.id)).query(
        'SELECT hash_redacted FROM events WHERE id=?',
        [String(message.event_id)],
      ),
      [{ hash_redacted: 1 }],
    );
    const topic = await f.source.addEvent({
      type: 'm.room.topic',
      state_key: '',
      content: {},
    });
    const rawTopic = structuredClone(topic);
    rawTopic.content = { injected: true };
    const create = [...f.source.events.values()].find((pdu) =>
      pdu.type === 'm.room.create'
    )!;
    const verified = await verifySnapshot({
      roomId: f.room.id,
      roomVersion: '11',
      resident: f.signing.name,
      self: f.signing.name,
      keys: fakeKeyResolver(f.signing),
      state: [structuredClone(create), rawTopic],
      authChain: [...f.source.events.values()].map((pdu) =>
        structuredClone(pdu)
      ),
    });
    await f.room.tx((tx) =>
      stageSnapshotEvidence(tx, verified, '$not-in-snapshot')
    );
    assertEquals(
      await (await f.home.room(f.room.id)).query(
        'SELECT hash_redacted FROM events WHERE id=?',
        [String(topic.event_id)],
      ),
      [{ hash_redacted: 1 }],
    );
  } finally {
    await f.close();
  }
});

Deno.test('replica signature evidence preserves full material for hash-valid already-redacted-shaped events', async () => {
  const f = await fixture();
  try {
    const message = await f.source.addEvent({
      type: 'm.room.message',
      content: {},
    });
    await f.ingest([structuredClone(message)]);
    const manifest = await exportReplicaRoom(f.room, f.tenant.serverName);
    const apply = () =>
      importReplicaRoom(f.edgeStore(), structuredClone(manifest), {
        self: f.tenant.serverName,
        keys: fakeKeyResolver(f.signing),
        signatureUnion: true,
      });
    await apply();
    const replica = await f.replica();
    const before = await replica.tx((tx) => tx.changes.head());
    manifest.after = manifest.cut;
    manifest.steps = [];
    manifest.events.find((pdu) => pdu.event_id === message.event_id)!.content =
      {
        injected: true,
      };
    await assertRejects(apply, MatrixError, 'replica changes a retained event');
    assertEquals(await replica.tx((tx) => tx.changes.head()), before);
  } finally {
    await f.close();
  }
});

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
    const boundary = manifest.boundaries.find((entry) =>
      entry.eventId === opening.eventId
    )!;
    boundary.state = [opening.createId];
    boundary.authChain = [];
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

Deno.test('replica signature-only packs retain verified evidence without changing wire bytes or live news', async () => {
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
      undefined,
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
    assertEquals(suffix.cut, head);
    assertEquals(
      suffix.events.find((pdu) => pdu.event_id === id)!
        .signatures![witness.name],
      undefined,
    );
    await apply();
    assertEquals(await replica.tx((tx) => tx.changes.head()), head);
    await f.reopen();
    assertEquals(
      JSON.parse((await (await f.replica()).tx((tx) => tx.events.get(id)))!.pdu)
        .signatures[witness.name],
      undefined,
    );
    // Invalid optional evidence is omitted, never a reason to reject the pack
    // or replace the verified witness. Full material remains immutable.
    target.signatures![witness.name][witness.keyId] = 'A'.repeat(86);
    await apply();
    assertEquals(
      JSON.parse((await (await f.replica()).tx((tx) => tx.events.get(id)))!.pdu)
        .signatures[witness.name],
      undefined,
    );
    const [held] = await (await f.edgeStore().room(replica.id)).query(
      'SELECT signatures FROM event_signatures WHERE event=?',
      [id],
    );
    assertEquals(JSON.parse(String(held.signatures))[witness.name], {
      [witness.keyId]: signature,
    });
    assertEquals(
      await (await f.replica()).tx((tx) => tx.changes.head()),
      head,
    );
    target.signatures![witness.name][witness.keyId] = signature;
    target.content = { ...target.content, injected: true };
    await assertRejects(apply);
    assertEquals(
      await (await f.replica()).tx((tx) => tx.changes.head()),
      head,
    );
  } finally {
    await f.close();
  }
});
Deno.test('replica wire: authenticated home copy supersedes the facade first copy without synthesizing a PDU', async () => {
  const f = await fixture();
  try {
    const original = await exportReplicaRoom(f.room, f.tenant.serverName);
    const own = structuredClone(original);
    const target = own.events.find((pdu) => pdu.type === 'm.room.create')!;
    const id = String(target.event_id);
    const witness = await makeRemoteServer('facade-witness.test');
    const body = redact(
      target as unknown as Record<string, unknown>,
      own.roomVersion,
    );
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
    await importReplicaRoom(f.edgeStore(), own, {
      self: f.tenant.serverName,
      keys: fakeKeyResolver(f.signing, witness),
      signatureUnion: true,
    });
    const replica = await f.replica();
    assertEquals(
      JSON.parse((await replica.tx((tx) => tx.events.get(id)))!.pdu),
      target,
    );
    const record = await exportRoomReplica(
      f.home,
      f.room,
      f.tenant.serverName,
      f.node.node,
      f.bundle.id,
      2,
    );
    assert(record);
    const journal = new Journal(await f.edgeServer(), LINK_SUPPORTED);
    await journal.receive('home', [record]);
    await (await f.replicas()).apply(journal, record);
    const home = original.events.find((pdu) => pdu.event_id === id)!;
    assertEquals(
      JSON.parse((await replica.tx((tx) => tx.events.get(id)))!.pdu),
      home,
    );
    assertEquals(
      JSON.parse((await replica.tx((tx) => tx.events.stored(id)))!),
      target,
    );
    await f.reopen();
    const wire = await exportReplicaRoom(
      await f.replica(),
      f.tenant.serverName,
    );
    assertEquals(wire.events.find((pdu) => pdu.event_id === id), home);
  } finally {
    await f.close();
  }
});

// Register HTTP compositions after the low-level/historical-schema cases. App
// recovery installs process-wide projection hooks, which require current schemas.
function appliedReadTests() {
  for (
    const pending of [
      'directory',
      'received room',
      'applying room',
      'partially applying room',
      'unrelated room',
    ] as const
  ) {
    Deno.test(
      'applied handler read stays available during a newer ' + pending +
        ' suffix',
      async () => {
        const f = await fixture();
        let http: Deno.HttpServer<Deno.NetAddr> | undefined;
        let application: Promise<boolean> | undefined;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        try {
          const topic = await f.source.addEvent({
            type: 'm.room.topic',
            state_key: '',
            content: { topic: 'applied topic' },
          });
          await f.ingest([topic]);
          const joined = await f.source.addEvent({
            type: 'm.room.member',
            state_key: '@bob:logical.test',
            sender: '@bob:logical.test',
            content: { membership: 'join' },
          });
          await f.ingest([joined]);
          await registerAlias(
            await f.home.server(),
            '#applied:logical.test',
            f.source.roomId,
            f.source.creator,
          );
          await setVisibility(await f.home.server(), f.source.roomId, 'public');
          const room = await f.exports(), inventory = await f.directoryExport();
          assert(room && inventory);
          const journal = await f.journal(),
            directory = await f.directoryOwner();
          await journal.receive('home', [room]);
          assert(await (await f.replicas()).apply(journal, room));
          await journal.receive('home', [inventory]);
          assert(await directory.apply(journal, inventory));
          setConfigForTests({
            server: { name: 'logical.test', role: 'facade' },
          });
          const tenant = await f.edgeTenant();
          const session = await registerUser(tenant, {
            localpart: 'zoe',
            password: 'applied-read-test',
          });
          await openReplicaApp(f.edgeStore(), tenant, {
            requireReadScope: (scope, absent) =>
              directory.requireReadScope(scope, absent),
            prepareReadRoomScope: (id, absent) =>
              directory.prepareReadRoomScope(id, absent),
            requireScope: (scope, absent) =>
              directory.requireScope(scope, absent),
            prepareRoomScope: (id, absent) =>
              directory.prepareRoomScope(id, absent),
            keys: keyStore(await f.edgeServer(), { signer: f.node.signer() }),
            signer: f.node.signer(),
            keyDocument: () => Promise.reject(new Error('unused key document')),
            publicRooms: async () => (await directory.snapshot())!.publicRooms,
          });
          // Handler-level HTTP proof: main's capability manifest does not mount
          // B6 client room routes yet. This prerequisite does not enable routes.
          http = Deno.serve({
            hostname: '127.0.0.1',
            port: 0,
            onListen: () => {},
          }, await pathfinder({ roots: ['api/endpoints/matrix/'] }));
          const get = async (suffix: string) => {
            const response = await fetch(
              `http://127.0.0.1:${http!.addr.port}/_matrix/client/v3/rooms/${
                encodeURIComponent(f.source.roomId)
              }/${suffix}`,
              {
                headers: { authorization: 'Bearer ' + session.access_token },
              },
            );
            return { status: response.status, body: await response.json() };
          };
          const path = 'event/' + encodeURIComponent(String(topic.event_id));
          const initial = await get(path);
          assertEquals(initial.status, 200, JSON.stringify(initial.body));
          await setPresence(
            await f.edgeServer(),
            '@bob:logical.test',
            'online',
            'applied presence',
          );
          assertEquals(
            (await getPresence(f.source.creator, '@bob:logical.test'))
              .statusMsg,
            'applied presence',
          );
          const readAdmission = await directory.prepareReadRoomScope(
            f.source.roomId,
          );
          const routes = [
            'messages?dir=b&limit=20',
            'members',
            'joined_members',
            'state',
            'aliases',
          ];
          for (const route of routes) {
            assertEquals((await get(route)).status, 200, route);
          }
          const alias = await resolveAlias('#applied:logical.test');
          const next = await f.source.addEvent({
            type: 'm.room.topic',
            state_key: '',
            content: { topic: 'new topic' },
          });
          await f.ingest([next]);
          const tail = pending === 'partially applying room'
            ? await f.source.addEvent({
              type: 'm.room.message',
              content: { body: 'unapplied tail' },
            })
            : null;
          if (tail) await f.ingest([tail]);
          let unrelated: Awaited<ReturnType<typeof f.exports>> = null;
          if (pending === 'unrelated room') {
            const created = await createRoom(f.home, {
              creator: '@other:logical.test',
            }, f.tenant.signer());
            unrelated = await exportRoomReplica(
              f.home,
              await openRoom(f.home, created.roomId),
              f.tenant.serverName,
              f.node.node,
              f.bundle.id,
            );
            assert(unrelated);
          }
          const suffix = await f.exports(),
            nextInventory = await f.directoryExport();
          assert(suffix && nextInventory);
          if (pending === 'directory') {
            await journal.receive('home', [nextInventory]);
          } else if (unrelated) {
            await journal.receive('home', [unrelated]);
            await journal.receive('home', [nextInventory]);
            assert(await directory.apply(journal, nextInventory));
          } else {
            await journal.receive('home', [suffix]);
            if (
              pending === 'applying room' ||
              pending === 'partially applying room'
            ) {
              const keys = fakeKeyResolver(f.signing);
              let tailVerifications = 0;
              application = new RoomReplicas(
                f.edgeStore(),
                await f.edgePairings(),
                f.tenant.serverName,
                {
                  async verifyEventSignature(...args) {
                    if (
                      !tail ||
                      (args[0].pdu.event_id === tail.event_id &&
                        ++tailVerifications === 2)
                    ) {
                      entered.resolve();
                      await release.promise;
                    }
                    return await keys.verifyEventSignature(...args);
                  },
                },
              ).apply(journal, suffix);
              await bounded(entered.promise, 3000);
              assertEquals(
                (await (await f.replicas()).status(f.source.roomId))!.ready,
                false,
              );
            }
          }
          // Admission still requires the newest received cut. Reading an already
          // applied publication is not that admission or a new receipt/ACK.
          const denied = await assertRejects(
            () => directory.scopeState('room:' + f.source.roomId),
            MatrixError,
          );
          assertEquals(denied.status, 503);
          const mutation = await assertRejects(
            () =>
              writeStateKey(
                f.source.roomId,
                f.source.creator,
                'm.room.topic',
                '',
                { topic: 'must not author' },
              ),
            MatrixError,
          );
          assertEquals(mutation.status, 503);
          await assertRejects(
            () =>
              serveEvent(String(topic.event_id), 'logical.test', serveDeps()),
            MatrixError,
            'replica unavailable',
          );
          await assertRejects(
            () => resolveAlias('#applied:logical.test', 'admission'),
            MatrixError,
            'replica unavailable',
          );
          assertEquals(
            (await federationHierarchy(f.source.roomId, 'logical.test', false))
              .room.room_id,
            f.source.roomId,
          );
          await (await f.edgeServer()).tx((conn) => readAdmission.check(conn));
          const before = await journal.heads('home', 'in', room);
          const read = await get(path);
          assertEquals(read.status, 200, JSON.stringify(read.body));
          // Age is response-time metadata; every retained event field stays equal.
          assert(read.body.unsigned.age >= initial.body.unsigned.age);
          assertEquals({
            ...read.body,
            unsigned: { ...read.body.unsigned, age: 0 },
          }, {
            ...initial.body,
            unsigned: { ...initial.body.unsigned, age: 0 },
          });
          assertEquals(await get('state/m.room.topic'), {
            status: 200,
            body: { topic: tail ? 'new topic' : 'applied topic' },
          });
          for (const route of routes) {
            assertEquals((await get(route)).status, 200, route);
          }
          assertEquals(await resolveAlias('#applied:logical.test'), alias);
          assertEquals(
            (await getPresence(f.source.creator, '@bob:logical.test'))
              .statusMsg,
            'applied presence',
          );
          assertEquals(
            (await journal.heads('home', 'in', room)).applied,
            before.applied,
          );
          if (pending === 'directory') {
            assert(await directory.apply(journal, nextInventory));
            // An inventory's successor cut constrains admission, not this ordinary
            // reader's already applied publication or its own causal obligations.
            await assertRejects(
              () => directory.prepareRoomScope(f.source.roomId),
              MatrixError,
              'replica unavailable',
            );
            assertEquals((await get(path)).status, 200);
            await journal.receive('home', [suffix]);
          }
          release.resolve();
          if (unrelated) await journal.receive('home', [suffix]);
          if (application) assert(await application);
          else assert(await (await f.replicas()).apply(journal, suffix));
          assertEquals(await get('state/m.room.topic'), {
            status: 200,
            body: { topic: 'new topic' },
          });
        } finally {
          release.resolve();
          if (application) await Promise.allSettled([application]);
          await http?.shutdown();
          await closeApp();
          await f.close();
          setConfigForTests({});
        }
      },
    );
  }

  Deno.test('applied read requires an initial completed scope and live enrollment across restart', async () => {
    const f = await fixture();
    try {
      const room = await f.exports(), inventory = await f.directoryExport();
      assert(room && inventory);
      let journal = await f.journal(), owner = await f.directoryOwner();
      await assertRejects(
        () => owner.requireReadScope('directory'),
        MatrixError,
        'replica unavailable',
      );
      await journal.receive('home', [inventory]);
      assert(await owner.apply(journal, inventory));
      await assertRejects(
        () => owner.requireReadScope(room.stream),
        MatrixError,
        'replica unavailable',
      );
      await journal.receive('home', [room]);
      await assertRejects(
        () => owner.requireReadScope(room.stream),
        MatrixError,
        'replica unavailable',
      );
      assert(await (await f.replicas()).apply(journal, room));
      await owner.requireReadScope(room.stream);
      const next = await f.source.addEvent({
        type: 'm.room.topic',
        state_key: '',
        content: { topic: 'restart suffix' },
      });
      await f.ingest([next]);
      const suffix = await f.exports();
      assert(suffix);
      await journal.receive('home', [suffix]);
      await f.reopen();
      owner = await f.directoryOwner();
      journal = await f.journal();
      await owner.requireReadScope(room.stream);
      await assertRejects(
        () => owner.requireScope(room.stream),
        MatrixError,
        'replica unavailable',
      );
      assertEquals(
        (await journal.heads('home', 'in', room)).applied.sequence,
        room.sequence,
      );
      await f.retire();
      await assertRejects(() => owner.requireReadScope(room.stream));
      await assertRejects(() => owner.prepareReadRoomScope(f.source.roomId));
    } finally {
      await f.close();
    }
  });

  Deno.test('PAIR503: federation hierarchy serves the applied child publication', async () => {
    const f = await fixture();
    try {
      const root = await createRoom(f.home, {
        creator: f.source.creator,
        preset: 'public_chat',
        creation_content: { type: 'm.space' },
        initial_state: [{
          type: 'm.space.child',
          state_key: f.source.roomId,
          content: { via: ['logical.test'] },
        }],
      }, f.tenant.signer());
      const rootRecord = await exportRoomReplica(
        f.home,
        await openRoom(f.home, root.roomId),
        f.tenant.serverName,
        f.node.node,
        f.bundle.id,
      );
      const childRecord = await f.exports(),
        inventory = await f.directoryExport();
      assert(rootRecord && childRecord && inventory);
      const journal = await f.journal(), directory = await f.directoryOwner();
      await journal.receive('home', [childRecord]);
      assert(await (await f.replicas()).apply(journal, childRecord));
      const publicKey = await importPublicKeyFromRaw(
        b64decode(f.tenant.publicB64),
      );
      const keys = productionKeyResolver(
        {
          getVerifyKey(name, keyId) {
            assertEquals(name, f.tenant.serverName);
            assertEquals(keyId, f.tenant.keyId);
            return Promise.resolve(publicKey);
          },
        },
      );
      await journal.receive('home', [rootRecord]);
      assert(
        await new RoomReplicas(
          f.edgeStore(),
          await f.edgePairings(),
          f.tenant.serverName,
          keys,
        ).apply(journal, rootRecord),
      );
      await journal.receive('home', [inventory]);
      assert(await directory.apply(journal, inventory));
      setConfigForTests({ server: { name: 'logical.test', role: 'facade' } });
      await openReplicaApp(f.edgeStore(), await f.edgeTenant(), {
        requireReadScope: (scope, absent) =>
          directory.requireReadScope(scope, absent),
        prepareReadRoomScope: (id, absent) =>
          directory.prepareReadRoomScope(id, absent),
        requireScope: (scope, absent) => directory.requireScope(scope, absent),
        prepareRoomScope: (id, absent) =>
          directory.prepareRoomScope(id, absent),
        keys: keyStore(await f.edgeServer(), { signer: f.node.signer() }),
        signer: f.node.signer(),
        keyDocument: () => Promise.reject(new Error('unused')),
        publicRooms: async () => (await directory.snapshot())!.publicRooms,
      });
      const initial = await federationHierarchy(
        root.roomId,
        'remote.test',
        false,
      );
      assertEquals(initial.children.map((child) => child.room_id), [
        f.source.roomId,
      ]);
      const next = await f.source.addEvent({
        type: 'm.room.server_acl',
        state_key: '',
        content: { allow: ['*'], deny: ['remote.test'] },
      });
      await f.ingest([next]);
      const suffix = await f.exports();
      assert(suffix);
      await journal.receive('home', [suffix]);
      const held = await journal.heads('home', 'in', suffix);
      assertEquals(held.received.sequence, suffix.sequence);
      assertEquals(held.applied.sequence, childRecord.sequence);
      assertEquals(
        await federationHierarchy(root.roomId, 'remote.test', false),
        initial,
      );
      assertEquals(await journal.heads('home', 'in', suffix), held);
      const client = await clientHierarchy(
        root.roomId,
        f.source.creator,
        hierarchyQuery(new URLSearchParams('limit=10')),
      );
      assert(client.rooms.some((room) => room.room_id === f.source.roomId));
      assert(await (await f.replicas()).apply(journal, suffix));
      const applied = await federationHierarchy(
        root.roomId,
        'remote.test',
        false,
      );
      assertEquals(applied.room, initial.room);
      assertEquals(applied.children, []);
      assertEquals(applied.inaccessible_children, [f.source.roomId]);
    } finally {
      await closeApp();
      await f.close();
      setConfigForTests({});
    }
  });

  for (
    const caller of [
      'state write',
      'federation alias',
      'federation directory',
    ] as const
  ) {
    Deno.test(
      'applied read split preserves nested admission for ' + caller,
      async () => {
        const f = await fixture();
        try {
          const topic = await f.source.addEvent({
            type: 'm.room.topic',
            state_key: '',
            content: { topic: 'same content' },
          });
          await f.ingest([topic]);
          await registerAlias(
            await f.home.server(),
            '#nested:logical.test',
            f.source.roomId,
            f.source.creator,
          );
          await setVisibility(await f.home.server(), f.source.roomId, 'public');
          const room = await f.exports(), inventory = await f.directoryExport();
          assert(room && inventory);
          const journal = await f.journal(),
            directory = await f.directoryOwner();
          await journal.receive('home', [room]);
          assert(await (await f.replicas()).apply(journal, room));
          await journal.receive('home', [inventory]);
          assert(await directory.apply(journal, inventory));
          const next = await f.source.addEvent({
            type: 'm.room.topic',
            state_key: '',
            content: { topic: 'newer authority' },
          });
          await f.ingest([next]);
          const suffix = await f.exports();
          assert(suffix);
          let received = false;
          setConfigForTests({
            server: { name: 'logical.test', role: 'facade' },
          });
          await openReplicaApp(f.edgeStore(), await f.edgeTenant(), {
            requireReadScope: (scope, absent) =>
              directory.requireReadScope(scope, absent),
            prepareReadRoomScope: (id, absent) =>
              directory.prepareReadRoomScope(id, absent),
            async requireScope(scope, absent) {
              await directory.requireScope(scope, absent);
              if (scope === room.stream && !received) {
                received = true;
                await journal.receive('home', [suffix]);
              }
            },
            prepareRoomScope: (id, absent) =>
              directory.prepareRoomScope(id, absent),
            keys: keyStore(await f.edgeServer(), { signer: f.node.signer() }),
            signer: f.node.signer(),
            keyDocument: () => Promise.reject(new Error('unused')),
            publicRooms: async () => (await directory.snapshot())!.publicRooms,
          });
          const action = () =>
            caller === 'state write'
              ? writeStateKey(
                f.source.roomId,
                f.source.creator,
                'm.room.topic',
                '',
                { topic: 'same content' },
              )
              : caller === 'federation alias'
              ? resolveAlias('#nested:logical.test', 'admission')
              : listLocalPublishedRooms(
                { network: { kind: 'native' } },
                'admission',
              );
          const denied = await assertRejects(
            action,
            MatrixError,
            'replica unavailable',
          );
          assertEquals(denied.status, 503);
          assert(received, 'suffix arrives after the outer admission');
        } finally {
          await closeApp();
          await f.close();
          setConfigForTests({});
        }
      },
    );
  }
}

Deno.test('ordinary v12 room directory inventory applies without an upgrade journal', async () => {
  const f = await fixture();
  try {
    const created = await createRoom(f.home, {
      creator: '@ordinary:logical.test',
      version: '12',
      alias: 'ordinary',
      visibility: 'public',
    }, f.tenant.signer());
    await registerAlias(
      await f.home.server(),
      '#ordinary:logical.test',
      created.roomId,
      '@ordinary:logical.test',
    );
    await setVisibility(await f.home.server(), created.roomId, 'public');
    assert(!created.roomId.includes(':'));
    const server = await f.home.server();
    const journalTables = await server.query(
      "SELECT name FROM sqlite_master WHERE name='room_upgrades'",
    );
    assertEquals(
      journalTables.length
        ? await server.query('SELECT * FROM room_upgrades')
        : [],
      [],
    );
    const record = await f.directoryExport();
    assert(record);
    const journal = await f.journal();
    await journal.receive('home', [record]);
    const owner = await f.directoryOwner();
    assert(await owner.apply(journal, record));
    assert((await owner.snapshot())?.rooms.includes(created.roomId));
    const directory = (await owner.snapshot())!.directory;
    assertEquals(
      directory.aliases.find((entry) =>
        entry.alias === '#ordinary:logical.test'
      )?.roomId,
      created.roomId,
    );
    assertEquals(
      directory.publication.find((entry) => entry.roomId === created.roomId)
        ?.visibility,
      'public',
    );
    assertEquals(
      directoryFactsOf({
        ...directory,
        forgotten: [{ user: '@ordinary:logical.test', roomId: created.roomId }],
      }, 'logical.test').forgotten[0].roomId,
      created.roomId,
    );
  } finally {
    await f.close();
  }
});

Deno.test('directory inventory rejects malformed room identities', async (t) => {
  for (
    const id of [
      '!bad',
      '!',
      '!room:',
      '!:server',
      '@room:server',
      '!' + 'x'.repeat(42),
      '!' + '/'.repeat(43),
    ]
  ) {
    await t.step(id, async () => {
      for (
        const facts of [
          {
            aliases: [{
              alias: '#bad:logical.test',
              roomId: id,
              creator: null,
            }],
            publication: [],
            forgotten: [],
          },
          {
            aliases: [],
            publication: [{
              roomId: id,
              visibility: 'public',
              purgeable: null,
            }],
            forgotten: [],
          },
          {
            aliases: [],
            publication: [],
            forgotten: [{ user: '@ordinary:logical.test', roomId: id }],
          },
        ]
      ) {
        assertThrows(
          () => directoryFactsOf(facts, 'logical.test'),
          MatrixError,
          'invalid public directory facts',
        );
      }
      const f = await fixture();
      try {
        const record = await f.directoryExport();
        assert(record);
        const payload = object(record.payload), view = object(payload.view);
        const bad = {
          ...record,
          payload: {
            ...payload,
            view: { ...view, rooms: [id], cuts: { ['room:' + id]: 0 } },
          },
        };
        const { hash, ...unsigned } = bad;
        assert(hash);
        bad.hash = recordHash(unsigned);
        const journal = await f.journal();
        await journal.receive('home', [bad]);
        await assertRejects(
          () => f.directoryOwner().then((owner) => owner.apply(journal, bad)),
          Error,
          'invalid scope inventory',
        );
        assertEquals(
          (await journal.heads('home', 'in', bad)).applied.sequence,
          0,
        );
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('PAIR503: signed membership validation precedes pending facade cuts', async (t) => {
  setConfigForTests({
    server: { name: 'logical.test' },
    federation: { enabled: true, mode: 'open' },
    facade: { phase: 'f2' },
  });
  const tls = await facadeTls();
  const f = await fixture(serverSchema, '11', certificatePin(tls.facade.cert));
  let child: Awaited<ReturnType<typeof facadeProcess>> | undefined;
  try {
    const journal = await f.journal(), directory = await f.directoryOwner();
    const initial = await f.directoryExport();
    assert(initial);
    await journal.receive('home', [initial]);
    assert(await directory.apply(journal, initial));
    const guest = await makeRemoteServer('guest.test');
    await seedServer(await f.edgeServer(), guest);
    await setVisibility(await f.home.server(), f.source.roomId, 'public');
    const room = await f.exports(), next = await f.directoryExport();
    assert(next?.hash && room);
    await journal.receive('home', [next]);
    await journal.receive('home', [room]);
    await f.edgeStore().close();
    const path = tls.dir + '/membership.toml';
    await Deno.writeTextFile(
      path,
      `[server]\nname="logical.test"\nrole="facade"\nport=0\n[store]\ndir="${f.dir}/edge"\n[media]\nroot="${f.dir}/media"\n[admin]\nsocket="${tls.dir}/mem.sock"\n[federation]\nenabled=true\nport=0\ncert="${tls.dir}/facade.crt"\nkey="${tls.dir}/facade.key"\n[facade]\nphase="f2"\nnodeid="edge_a"\nurl="https://facade.test"\nlinkport=0\nlinkcert="${tls.dir}/facade.crt"\nlinkkey="${tls.dir}/facade.key"\nlinkcacerts=["${tls.dir}/ca.crt"]\npollseconds=1\n`,
    );
    const directoryHold = 'apply:' + next.stream;
    const roomHold = 'apply:' + room.stream;
    child = await facadeProcess(path, 'facade: link/local admin ready', [
      directoryHold,
      roomHold,
    ]);
    const waiting = await child.holdPublication(directoryHold);
    await bounded(waiting.held(), 5000);
    const base = `http://127.0.0.1:${await child.port('client')}`;
    const caller = (signal?: AbortSignal) =>
      fedCaller((request) => {
        const url = new URL(request.url);
        return fetch(new Request(base + url.pathname, request), { signal });
      }, guest);
    const observations = child.observations;
    const event = async (membership: string) => {
      const sender = '@guest:guest.test';
      return await signTemplate({
        room_id: f.source.roomId,
        type: 'm.room.member',
        sender,
        state_key: sender,
        content: { membership },
        depth: 5,
        prev_events: [],
        auth_events: [],
      }, guest);
    };
    const check = async (
      endpoint: string,
      membership: string,
      stream: string,
    ) => {
      const valid = await event(membership);
      const uri = '/_matrix/federation/' + endpoint + '/' +
        encodeURIComponent(f.source.roomId) + '/' +
        encodeURIComponent(String(valid.event_id));
      const malformed = { ...valid, type: 'm.room.message' };
      const unsigned = await fetch(base + uri, {
        method: 'PUT',
        body: JSON.stringify(malformed),
      });
      await unsigned.body?.cancel();
      const bad = await caller()('PUT', uri, malformed);
      assertEquals([bad.status, bad.body.errcode], [400, 'M_BAD_JSON']);
      assertEquals(unsigned.status, 401);

      const abort = new AbortController();
      const mark = observations.mark();
      const pending = caller(abort.signal)('PUT', uri, valid);
      try {
        await bounded(
          Promise.race([
            observations.wait(
              (o) =>
                o.kind === 'readiness' && o.stream === stream &&
                o.state === 'pending',
              mark,
            ),
            pending.then(({ status }) => {
              throw new Error(`membership answered before apply: ${status}`);
            }),
          ]),
          5000,
        );
        abort.abort();
        await bounded(
          assertRejects(() => pending, DOMException, 'aborted'),
          5000,
        );
        // The server's wait must unwind without releasing the publication.
        await bounded(
          observations.wait(
            (o) =>
              o.kind === 'readiness' && o.stream === stream &&
              o.state === 'cancelled',
            mark,
          ),
          5000,
        );
      } finally {
        abort.abort();
      }
    };
    await t.step(
      'send_join with pending directory',
      () => check('v2/send_join', 'join', next.stream),
    );
    await waiting.release();
    await bounded(
      child.observations.tail('home', [{
        ...next,
        received: { sequence: next.sequence, hash: next.hash },
      }]),
      5000,
    );
    await bounded((await child.holdPublication(roomHold)).held(), 5000);
    await t.step(
      'send_knock with pending room',
      () => check('v1/send_knock', 'knock', room.stream),
    );
  } finally {
    await child?.dispose();
    await tls.close();
    await f.close();
    setConfigForTests({});
  }
});

for (const dependency of ['directory', 'account'] as const) {
  Deno.test(`PAIR503: federation admission waits for held ${dependency} publication`, async () => {
    setConfigForTests({
      server: { name: 'logical.test' },
      federation: { enabled: true, mode: 'open' },
      facade: { phase: 'f2' },
    });
    const tls = await facadeTls();
    const f = await fixture(serverSchema, '11', tls.facadePin);
    let child: Awaited<ReturnType<typeof facadeProcess>> | undefined;
    try {
      const pairings = await f.edgePairings(), server = await f.edgeServer();
      const journal = new Journal(server, LINK_SUPPORTED);
      const directory = await f.directoryOwner();
      const guest = await makeRemoteServer('guest.test');
      await seedServer(server, guest);
      const publishDirectory = async () => {
        await recoverServer(f.home);
        const record = await exportDirectoryReplica(
          f.home,
          f.tenant,
          f.node.node,
          f.bundle.id,
          2,
        );
        assert(record);
        await journal.receive('home', [record]);
        return record;
      };
      let request: Parameters<ReturnType<typeof fedCaller>>;
      let publication;
      if (dependency === 'directory') {
        const room = await f.exports();
        assert(room);
        await journal.receive('home', [room]);
        assert(await (await f.replicas()).apply(journal, room));
        assert(await directory.apply(journal, await publishDirectory()));
        await setVisibility(await f.home.server(), f.source.roomId, 'public');
        publication = await publishDirectory();
        request = [
          'GET',
          '/_matrix/federation/v1/make_knock/' +
          encodeURIComponent(f.source.roomId) + '/%40guest%3Aguest.test?ver=11',
        ];
      } else {
        const keyOwner = new FacadeKeys(
          server,
          f.node.signer(),
          f.node.publicKey,
          pairings,
        );
        const roster = await exportKeyRoster(
          f.home,
          f.tenant,
          f.node.node,
          f.bundle.id,
          (_id, doc) => keyOwner.cosign(doc),
        );
        assert(roster);
        await journal.receive('home', [roster]);
        assert(await keyOwner.apply(journal, roster));
        await f.tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
        const control = await exportOwnerControl(
          f.home,
          f.tenant,
          f.homePairings,
          f.bundle.id,
        );
        await enrolledTenant(
          f.edgeStore(),
          pairings,
          'logical.test',
          f.node.node,
        );
        const controls = new OwnerControls(
          server,
          await f.edgeStore().tenant('logical.test'),
          pairings,
          f.node,
        );
        await journal.receive('home', [control]);
        assert(await controls.apply(journal, control));
        publication = await exportAccountAuth(
          f.home,
          f.tenant,
          f.homePairings,
          f.bundle.id,
          'alice',
          false,
        );
        assertEquals(
          await new MembershipOperations(f.home, f.tenant, f.homePairings)
            .bootstrap('alice', f.bundle.id),
          [],
        );
        assert(await directory.apply(journal, await publishDirectory()));
        await journal.receive('home', [publication]);
        const roomId = '!inbound-invite:guest.test';
        const invite = await signTemplate({
          room_id: roomId,
          type: 'm.room.member',
          sender: '@guest:guest.test',
          state_key: '@alice:logical.test',
          content: { membership: 'invite' },
          depth: 5,
          prev_events: [],
          auth_events: [],
        }, guest);
        request = [
          'PUT',
          '/_matrix/federation/v2/invite/' + encodeURIComponent(roomId) + '/' +
          encodeURIComponent(String(invite.event_id)),
          { room_version: '11', event: invite, invite_room_state: [] },
        ];
      }
      const before = await journal.heads('home', 'in', publication);
      assertEquals(before.received.sequence, publication.sequence);
      assertEquals(before.applied.sequence, publication.sequence - 1);
      assert(publication.hash);
      await f.edgeStore().close();
      const path = tls.dir + '/readiness.toml';
      await Deno.writeTextFile(
        path,
        `[server]\nname="logical.test"\nrole="facade"\nport=0\n[store]\ndir="${f.dir}/edge"\n[media]\nroot="${f.dir}/media"\n[admin]\nsocket="${tls.dir}/ready.sock"\n[federation]\nenabled=true\nport=0\ncert="${tls.dir}/facade.crt"\nkey="${tls.dir}/facade.key"\n[facade]\nphase="f2"\nnodeid="edge_a"\nurl="https://facade.test"\nlinkport=0\nlinkcert="${tls.dir}/facade.crt"\nlinkkey="${tls.dir}/facade.key"\nlinkcacerts=["${tls.dir}/ca.crt"]\npollseconds=1\n`,
      );
      const hold = 'apply:' + publication.stream;
      child = await facadeProcess(path, 'facade: link/local admin ready', [
        hold,
      ]);
      const waiting = await child.holdPublication(hold);
      await bounded(waiting.held(), 5000);
      const base = `http://127.0.0.1:${await child.port('client')}`;
      const call = fedCaller((request) => {
        const url = new URL(request.url);
        return fetch(new Request(base + url.pathname + url.search, request));
      }, guest);
      const pending = call(...request);
      const early = await Promise.race([
        pending.then((result) => [result.status, result.body.errcode]),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 750)),
      ]);
      await waiting.release();
      await bounded(
        child.observations.tail('home', [{
          ...publication,
          received: { sequence: publication.sequence, hash: publication.hash },
        }]),
        5000,
      );
      // A baseline early refusal must not hide an invalid fixture. Check the
      // exact signed operation after actual apply before asserting the wait.
      const result = await bounded(
        early === null ? pending : call(...request),
        5000,
      );
      if (dependency === 'directory') {
        assertEquals([result.status, result.body.errcode], [
          403,
          'M_FORBIDDEN',
        ]);
      } else {
        assertEquals(result.status, 200, JSON.stringify(result.body));
        assert(object(object(result.body.event).signatures)['logical.test']);
      }
      assertEquals(
        early,
        null,
        'admission answered before the required cut applied',
      );
    } finally {
      await child?.dispose();
      await tls.close();
      await f.close();
      setConfigForTests({});
    }
  });
}

Deno.test('PAIR503: missing room delivery waits until poll reconciliation expires', async () => {
  setConfigForTests({
    server: { name: 'logical.test' },
    federation: { enabled: true, mode: 'open' },
    facade: { phase: 'f2' },
  });
  const tls = await facadeTls();
  const f = await fixture(serverSchema, '11', tls.facadePin, tls.homePin);
  let child: Awaited<ReturnType<typeof facadeProcess>> | undefined;
  try {
    const journal = await f.journal(), directory = await f.directoryOwner();
    const first = await f.exports(), initial = await f.directoryExport();
    assert(first?.hash && initial);
    await journal.receive('home', [first]);
    await journal.receive('home', [initial]);
    assert(await (await f.replicas()).apply(journal, first));
    assert(await directory.apply(journal, initial));

    const message = await f.source.addEvent({
      type: 'm.room.message',
      content: { body: 'advertised but not yet delivered' },
    });
    await f.ingest([message]);
    const inventory = await f.directoryExport(), suffix = await f.exports();
    assert(inventory && suffix?.hash);
    await journal.receive('home', [inventory]);
    assert(await directory.apply(journal, inventory));
    const guest = await makeRemoteServer('guest.test');
    await seedServer(await f.edgeServer(), guest);
    await f.edgeStore().close();

    const path = tls.dir + '/expiry.toml';
    const pollSeconds = 3;
    await Deno.writeTextFile(
      path,
      `[server]\nname="logical.test"\nrole="facade"\nport=0\n[store]\ndir="${f.dir}/edge"\n[media]\nroot="${f.dir}/media"\n[admin]\nsocket="${tls.dir}/expiry.sock"\n[federation]\nenabled=true\nport=0\ncert="${tls.dir}/facade.crt"\nkey="${tls.dir}/facade.key"\n[facade]\nphase="f2"\nnodeid="edge_a"\nurl="https://facade.test"\nlinkport=0\nlinkcert="${tls.dir}/facade.crt"\nlinkkey="${tls.dir}/facade.key"\nlinkcacerts=["${tls.dir}/ca.crt"]\nnotify="poll"\npollseconds=${pollSeconds}\n`,
    );
    child = await facadeProcess(path, 'facade: link/local admin ready');
    const base = `http://127.0.0.1:${await child.port('client')}`;
    const uri = '/_matrix/federation/v1/make_knock/' +
      encodeURIComponent(f.source.roomId) + '/%40guest%3Aguest.test?ver=11';
    const call = fedCaller((request) => {
      const url = new URL(request.url);
      return fetch(new Request(base + url.pathname + url.search, request));
    }, guest);
    const peer = await f.homePairings.connection(f.bundle.id);
    assert(peer.grant);
    const client = new JournalClient(
      new LinkClient(tls.home, {
        url: `https://127.0.0.1:${await child.port('link')}`,
        pin: tls.facadePin,
      }),
      {
        server: peer.context.server,
        node: peer.context.node,
        pairing: f.bundle.id,
        incarnation: peer.grant.body.transcript.body.incarnation,
        revision: peer.grant.body.revision,
      },
      () => Promise.resolve(),
    );
    const began = performance.now();
    const hello = await client.hello();
    const before = { sequence: first.sequence, hash: first.hash };
    assertEquals(
      hello.incoming.find(({ stream }) => stream === suffix.stream)?.received,
      before,
    );
    // No polling or delivery until this request returns. The facade knows the
    // room needs a higher cut from the installed directory inventory.
    const mark = child.observations.mark();
    const pending = call('GET', uri);
    await bounded(
      Promise.race([
        child.observations.wait(
          (o) =>
            o.kind === 'readiness' && o.stream === suffix.stream &&
            o.state === 'pending',
          mark,
        ),
        pending.then(({ status }) => {
          throw new Error(`federation answered before readiness: ${status}`);
        }),
      ]),
      5000,
    );
    const expired = await bounded(pending, pollSeconds * 1000 + 5000);
    assertEquals([expired.status, expired.body.errcode], [
      503,
      'M_UNAVAILABLE',
    ]);
    assert(
      performance.now() - began >= pollSeconds * 1000,
      'admission answered before the poll freshness window expired',
    );

    // The expiry was not a publication: the next hello still sees the old cut.
    assertEquals(
      (await client.hello()).incoming.find(({ stream }) =>
        stream === suffix.stream
      )?.received,
      before,
    );
  } finally {
    await child?.dispose();
    await tls.close();
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('cold inbox rejection before Journal.apply rejects the finite tail promptly', async () => {
  const tls = await facadeTls();
  const f = await fixture(serverSchema, '11', certificatePin(tls.facade.cert));
  let child: Awaited<ReturnType<typeof facadeProcess>> | undefined;
  try {
    const record = await f.directoryExport();
    assert(record);
    const payload = object(record.payload), view = object(payload.view);
    const bad = {
      ...record,
      payload: { ...payload, view: { ...view, rooms: ['!invalid'] } },
    };
    const { hash, ...unsigned } = bad;
    assert(hash);
    bad.hash = recordHash(unsigned);
    const journal = await f.journal();
    await journal.receive('home', [bad]);
    await f.edgeStore().close();
    const path = tls.dir + '/rejection.toml';
    await Deno.writeTextFile(
      path,
      `[server]\nname="logical.test"\nrole="facade"\nport=0\n[store]\ndir="${f.dir}/edge"\n[media]\nroot="${f.dir}/media"\n[admin]\nsocket="${tls.dir}/reject.sock"\n[federation]\nenabled=false\n[facade]\nnodeid="edge_a"\nurl="https://facade.test"\nlinkport=0\nlinkcert="${tls.dir}/facade.crt"\nlinkkey="${tls.dir}/facade.key"\nlinkcacerts=["${tls.dir}/ca.crt"]\npollseconds=1\n`,
    );
    child = await facadeProcess(path, 'facade: link/local admin ready');
    const observing = child;
    await assertRejects(
      () =>
        bounded(
          observing.observations.tail('home', [{
            ...bad,
            received: { sequence: bad.sequence, hash: bad.hash },
          }]),
          2000,
        ),
      Error,
      'inbox directory',
    );
    await child.stop();
  } finally {
    await child?.dispose();
    await tls.close();
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

Deno.test('operator reverse progress resolves the active enrollment after reenrolling the same node incarnation', async () => {
  const f = await fixture();
  try {
    const initial = (await f.exports())!;
    const edgeJournal = await f.journal();
    await edgeJournal.receive('home', [initial]);
    assert(await (await f.replicas()).apply(edgeJournal, initial));
    const incoming = new Journal(await f.home.server(), LINK_SUPPORTED);
    const owner = new RoomReplicas(
      f.home,
      f.homePairings,
      f.tenant.serverName,
      fakeKeyResolver(f.signing),
    );
    const oldReverse = (await exportRoomReplica(
      f.edgeStore(),
      await f.replica(),
      f.tenant.serverName,
      'home',
      f.bundle.id,
    ))!;
    await incoming.receive(f.node.node, [oldReverse]);
    assert(await owner.apply(incoming, oldReverse, f.bundle.id));
    const edge = await f.edgePairings();
    await edge.retire(await f.homePairings.revoke(f.bundle.id), 'a'.repeat(64));
    const next = await f.homePairings.create({
      node: f.node.node,
      url: 'https://facade.test',
      facadePin: 'b'.repeat(64),
      expires: Date.now() + 60000,
      required: [...LINK_CAPABILITIES],
    });
    await edge.accept(next);
    const grant = await f.homePairings.grant(
      next.id,
      await edge.challenge(next.id, next.secret, 'a'.repeat(64)),
    );
    await f.homePairings.confirm(
      next.id,
      await edge.complete(next.id, grant, 'a'.repeat(64)),
    );
    assert(next.id !== f.bundle.id);
    assertEquals(grant.body.transcript.body.incarnation, f.node.incarnation);
    const pending = (await replicationProgress(
      f.home,
      f.tenant.serverName,
      'home',
      [oldReverse.stream],
    )).streams.find((row) =>
      row.direction === 'in' && row.source === f.node.node &&
      row.incarnation === f.node.incarnation
    )!;
    assertEquals(pending.ready, false);
    assertEquals(pending.published, null);
    // The new enrollment owns its applied scope, while the source identity persists.
    assert(
      await exportRoomReplica(
        f.home,
        f.room,
        f.tenant.serverName,
        f.node.node,
        next.id,
      ),
    );
    const reverse = (await exportRoomReplica(
      f.edgeStore(),
      await f.replica(),
      f.tenant.serverName,
      'home',
      next.id,
    ))!;
    await incoming.receive(f.node.node, [reverse]);
    assert(await owner.apply(incoming, reverse, next.id));
    const progress = await replicationProgress(
      f.home,
      f.tenant.serverName,
      'home',
      [reverse.stream],
    );
    const applied = progress.streams.find((row) =>
      row.direction === 'in' && row.source === f.node.node &&
      row.incarnation === f.node.incarnation
    )!;
    assertEquals(applied.ready, true);
    assertEquals(applied.published, applied.applied);
    assertEquals(
      applied.applied.sourceCut,
      (reverse.payload as {
        manifest: { cut: number };
      }).manifest.cut,
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

    // Journal identity is the node incarnation, but scope completion belongs
    // to the enrollment. The read-only operator view must resolve that binding.
    assert(f.bundle.id !== f.node.incarnation);
    const progress = await replicationProgress(
      f.home,
      f.tenant.serverName,
      'home',
      [reverse.stream],
    );
    const applied = progress.streams.find((row) =>
      row.direction === 'in' && row.source === f.node.node &&
      row.incarnation === f.node.incarnation
    )!;
    assertEquals(applied.ready, true);
    assertEquals(applied.published, applied.applied);
    assertEquals(
      applied.applied.sourceCut,
      (reverse.payload as {
        manifest: { cut: number };
      }).manifest.cut,
    );
    assertEquals(applied.declaredCut, null);

    const foreignJournal = new Journal(await f.edgeServer(), LINK_SUPPORTED);
    const foreign = await foreignJournal.append('home', {
      source: f.node.node,
      incarnation: 'unbound-node-incarnation',
      stream: reverse.stream,
      type: reverse.type,
      version: reverse.version,
      operationId: 'foreign-progress-binding',
      payload: reverse.payload,
    });
    await incoming.receive(f.node.node, [foreign]);
    const unbound = (await replicationProgress(
      f.home,
      f.tenant.serverName,
      'home',
      [reverse.stream],
    )).streams.find((row) => row.incarnation === foreign.incarnation)!;
    assertEquals(unbound.ready, false);
    assertEquals(unbound.published, null);

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
    // Completion independently rechecks the grant even when its caller
    // supplied no room effect and changed the database directly.
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

Deno.test('reverse room admission: revocation during verification cannot commit room effects', async () => {
  const f = await fixture();
  try {
    const initial = await f.exports();
    assert(initial);
    const journal = await f.journal();
    await journal.receive('home', [initial]);
    await (await f.replicas()).apply(journal, initial);
    const replica = await f.replica();
    const message = await f.source.addEvent({
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: 'not admitted after revocation' },
    });
    await ingestRemote(replica, [message], f.signing.name, {
      keys: fakeKeyResolver(f.signing),
      self: f.signing.name,
      fetcher: fakeFetcher({}).fetcher,
      limits: { waitMs: 0, limit: 100, budgetMs: 1000 },
      ungroundedMs: 3600000,
    });
    const reverse = await exportRoomReplica(
      f.edgeStore(),
      replica,
      f.tenant.serverName,
      'home',
      f.bundle.id,
    );
    assert(reverse);
    const incoming = new Journal(await f.home.server(), LINK_SUPPORTED);
    await incoming.receive(f.node.node, [reverse]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const keys = fakeKeyResolver(f.signing);
    const owner = new RoomReplicas(
      f.home,
      f.homePairings,
      f.tenant.serverName,
      {
        verifyEventSignature: async (args) => {
          entered.resolve();
          await release.promise;
          return await keys.verifyEventSignature(args);
        },
      },
    );
    const before = await f.room.tx((tx) => tx.changes.head());
    const applying = owner.apply(incoming, reverse, f.bundle.id).then(
      () => null,
      (error) => error,
    );
    await entered.promise;
    await f.homePairings.revoke(f.bundle.id);
    release.resolve();
    assert(await applying instanceof Error);
    assertEquals(
      await f.room.tx((tx) => tx.events.get(String(message.event_id))),
      null,
    );
    assertEquals(await f.room.tx((tx) => tx.changes.head()), before);
    assertEquals(
      (await incoming.heads(f.node.node, 'in', reverse)).applied.sequence,
      0,
    );
  } finally {
    await f.close();
  }
});

Deno.test('replica participation reconciles concurrent last-local leave and join in both arrival orders', async (t) => {
  for (const closedFirst of [true, false]) {
    await t.step(
      closedFirst ? 'closed receiver first' : 'closed source first',
      async () => {
        const f = await fixture();
        try {
          const options = {
            self: f.signing.name,
            keys: fakeKeyResolver(f.signing),
            signatureUnion: true,
          };
          await importReplicaRoom(
            f.edgeStore(),
            await exportReplicaRoom(f.room, options.self),
            options,
          );
          const replica = await f.replica();
          const homeCut = await f.room.tx((tx) => tx.changes.head());
          const edgeCut = await replica.tx((tx) => tx.changes.head());
          const parent = f.source.tipId;
          const historical = await replica.tx((tx) =>
            tx.state.eventReadState(parent)
          );
          const newcomer = '@newcomer:' + options.self;
          const leave = await f.source.addEvent({
            type: 'm.room.member',
            state_key: f.source.creator,
            content: { membership: 'leave' },
            prev_events: [parent],
          });
          const join = await f.source.addEvent({
            type: 'm.room.member',
            sender: newcomer,
            state_key: newcomer,
            content: { membership: 'join' },
            prev_events: [parent],
          });
          await f.ingest([leave]);
          assertEquals(await f.room.tx((tx) => tx.segments.openStay()), null);
          await ingestRemote(replica, [join], options.self, {
            ...options,
            fetcher: fakeFetcher({}).fetcher,
            limits: { waitMs: 0, limit: 100, budgetMs: 1000 },
            ungroundedMs: 3600000,
          });
          const homeSuffix = await exportReplicaRoom(
            f.room,
            options.self,
            homeCut,
          );
          const edgeSuffix = await exportReplicaRoom(
            replica,
            options.self,
            edgeCut,
          );
          const reopen = () =>
            importReplicaRoom(f.home, structuredClone(edgeSuffix), options);
          const retain = () =>
            importReplicaRoom(
              f.edgeStore(),
              structuredClone(homeSuffix),
              options,
            );
          for (
            const apply of closedFirst ? [reopen, retain] : [retain, reopen]
          ) await apply();
          for (const room of [f.room, replica]) {
            const retained = await room.tx(async (tx) => {
              const stay = await tx.segments.openStay();
              assert(stay);
              const group = await tx.state.current(stay.id);
              assert(group !== null);
              return {
                creator: await tx.state.groupKey(
                  group,
                  'm.room.member',
                  f.source.creator,
                ),
                newcomer: await tx.state.groupKey(
                  group,
                  'm.room.member',
                  newcomer,
                ),
                frontier: await tx.extremities.frontier(stay.id),
              };
            });
            assertEquals(retained.creator, leave.event_id);
            assertEquals(retained.newcomer, join.event_id);
            assertEquals(
              retained.frontier.sort(),
              [String(leave.event_id), String(join.event_id)].sort(),
            );
            for (const pdu of [leave, join]) {
              assertEquals(
                (await room.tx((tx) =>
                  tx.events.getStatus(String(pdu.event_id))
                ))?.standing,
                'accepted',
              );
              assertEquals(
                (await room.tx((tx) => tx.changes.after(0, 100))).filter((
                  change,
                ) =>
                  ['event', 'transition'].includes(change.kind) &&
                  change.event === pdu.event_id &&
                  JSON.parse(change.data).grounding === 'grounded'
                ).length,
                1,
              );
            }
            assert(await canSeeEvent(f.source.creator, room, parent));
            assert(await canSeeEvent(newcomer, room, parent));
            assertEquals(
              await canSeeEvent('@unjoined:' + options.self, room, parent),
              false,
            );
          }
          assertEquals(
            await replica.tx((tx) => tx.state.eventReadState(parent)),
            historical,
          );
          const heads = await Promise.all(
            [f.room, replica].map((room) => room.tx((tx) => tx.changes.head())),
          );
          await reopen();
          await retain();
          assertEquals(
            await Promise.all(
              [f.room, replica].map((room) =>
                room.tx((tx) => tx.changes.head())
              ),
            ),
            heads,
          );
        } finally {
          await f.close();
        }
      },
    );
  }
});

Deno.test('replica participation merges a new source stay into an active receiver without replacing its branch', async () => {
  const f = await fixture();
  try {
    const options = {
      self: f.signing.name,
      keys: fakeKeyResolver(f.signing),
      signatureUnion: true,
    };
    await importReplicaRoom(
      f.edgeStore(),
      await exportReplicaRoom(f.room, options.self),
      options,
    );
    const replica = await f.replica();
    const parent = f.source.tipId;
    const leave = await f.source.addEvent({
      type: 'm.room.member',
      state_key: f.source.creator,
      content: { membership: 'leave' },
      prev_events: [parent],
    });
    const resident = '@resident:' + options.self;
    const localJoin = await f.source.addEvent({
      type: 'm.room.member',
      sender: resident,
      state_key: resident,
      content: { membership: 'join' },
      prev_events: [parent],
    });
    await f.ingest([localJoin]);
    await ingestRemote(replica, [leave], options.self, {
      ...options,
      fetcher: fakeFetcher({}).fetcher,
      limits: { waitMs: 0, limit: 100, budgetMs: 1000 },
      ungroundedMs: 3600000,
    });
    assertEquals(await replica.tx((tx) => tx.segments.openStay()), null);
    const noBoundary = await exportReplicaRoom(f.room, options.self);
    noBoundary.boundaries = noBoundary.boundaries.filter((boundary) =>
      boundary.eventId !== localJoin.event_id
    );
    await assertRejects(
      () => importReplicaRoom(f.edgeStore(), noBoundary, options),
      MatrixError,
      'replica live participation',
    );
    assertEquals(await replica.tx((tx) => tx.segments.openStay()), null);
    const newcomer = '@newcomer:' + options.self;
    const join = await f.source.addEvent({
      type: 'm.room.member',
      sender: newcomer,
      state_key: newcomer,
      content: { membership: 'join' },
      prev_events: [String(leave.event_id)],
    });
    const before = f.source.stateIdsAt(String(join.event_id))!;
    // A previously staged authentic join must be promoted once, not treated as
    // a completed receipt that opens an empty stay.
    const child = await f.source.addEvent({
      type: 'm.room.message',
      sender: newcomer,
      content: { msgtype: 'm.text', body: 'evidence only' },
    });
    const evidenceIds = f.source.stateIdsAt(String(child.event_id))!;
    const evidence = await verifySnapshot({
      ...options,
      roomId: replica.id,
      roomVersion: f.source.version,
      resident: options.self,
      state: evidenceIds.pduIds.map((id) => f.source.event(id)!),
      authChain: evidenceIds.authChainIds.map((id) => f.source.event(id)!),
    });
    await replica.tx((tx) =>
      stageSnapshotEvidence(tx, evidence, String(child.event_id))
    );
    assertEquals(
      (await replica.tx((tx) => tx.events.getStatus(String(join.event_id))))
        ?.grounding,
      'evidence',
    );
    await importReplicaBoundary(f.edgeStore(), {
      ...options,
      reconcile: true,
      roomId: replica.id,
      roomVersion: f.source.version,
      resident: options.self,
      join,
      state: before.pduIds.map((id) => f.source.event(id)!),
      authChain: before.authChainIds.map((id) => f.source.event(id)!),
    });
    const active = await f.room.tx((tx) => tx.segments.openStay());
    assert(active);
    const suffix = await exportReplicaRoom(replica, options.self);
    await importReplicaRoom(f.home, structuredClone(suffix), options);
    assertEquals(
      (await f.room.tx((tx) => tx.segments.openStay()))?.id,
      active.id,
    );
    const held = await f.room.tx(async (tx) => {
      const group = await tx.state.current(active.id);
      assert(group !== null);
      return {
        resident: await tx.state.groupKey(group, 'm.room.member', resident),
        newcomer: await tx.state.groupKey(group, 'm.room.member', newcomer),
        creator: await tx.state.groupKey(
          group,
          'm.room.member',
          f.source.creator,
        ),
        frontier: await tx.extremities.frontier(active.id),
      };
    });
    assertEquals(held.resident, localJoin.event_id);
    assertEquals(held.newcomer, join.event_id);
    assertEquals(held.creator, leave.event_id);
    assertEquals(
      held.frontier.sort(),
      [String(localJoin.event_id), String(join.event_id)].sort(),
    );
    const count = await f.room.tx((tx) => tx.segments.list());
    const head = await f.room.tx((tx) => tx.changes.head());
    await importReplicaRoom(f.home, suffix, options);
    assertEquals(await f.room.tx((tx) => tx.changes.head()), head);
    assertEquals(await f.room.tx((tx) => tx.segments.list()), count);
    const residentLeave = await f.source.addEvent({
      type: 'm.room.member',
      sender: resident,
      state_key: resident,
      content: { membership: 'leave' },
      prev_events: [String(localJoin.event_id), String(join.event_id)],
    });
    const newcomerLeave = await f.source.addEvent({
      type: 'm.room.member',
      sender: newcomer,
      state_key: newcomer,
      content: { membership: 'leave' },
    });
    await f.ingest([residentLeave, newcomerLeave]);
    assertEquals(await f.room.tx((tx) => tx.segments.openStay()), null);
    const archived = await f.room.tx((tx) => tx.segments.list());
    const archivedHead = await f.room.tx((tx) => tx.changes.head());
    // That old source opening was grounded in our existing stay. Replaying it
    // after a later departure must not manufacture an empty reopened stay.
    await importReplicaRoom(f.home, structuredClone(suffix), options);
    assertEquals(await f.room.tx((tx) => tx.segments.openStay()), null);
    assertEquals(await f.room.tx((tx) => tx.segments.list()), archived);
    assertEquals(await f.room.tx((tx) => tx.changes.head()), archivedHead);
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
    const pendingSelection = await assertRejects(
      () => owner.apply(journal, record, f.bundle.id),
      LinkError,
    );
    assertEquals(pendingSelection.code, 'LINK_UNAVAILABLE');
    assertEquals(pendingSelection.status, 503);
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

Deno.test('room readiness waits for missing and held verification authority without refusing its consumer or moving its cut', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let applying: Promise<boolean> | undefined;
  let worker: ReturnType<typeof startInboxWorker> | undefined;
  const observations = new FacadeObservations();
  try {
    const created = await createRoom(f.home, {
      creator: '@ready:logical.test',
      version: '11',
    }, f.tenant.signer());
    const room = await openRoom(f.home, created.roomId);
    const record = await exportRoomReplica(
      f.home,
      room,
      f.tenant.serverName,
      f.node.node,
      f.bundle.id,
    );
    assert(record);
    const journal = await f.journal();
    await journal.receive('home', [record]);
    const server = await f.edgeServer();
    const keys = new FacadeKeys(
      server,
      f.node.signer(),
      f.node.publicKey,
      await f.edgePairings(),
    );
    const replicas = new RoomReplicas(
      f.edgeStore(),
      await f.edgePairings(),
      f.tenant.serverName,
      productionKeyResolver(keys.verificationKeys()),
    );
    let finished = false;
    const consumer = observations.fact(
      applicationScope('home', record, 0),
      () => true,
    )
      .then((value) => {
        finished = true;
        return value;
      }, (error) => {
        finished = true;
        return error;
      });
    let attempt = Promise.withResolvers<ReturnType<typeof facadeFailure>>();
    worker = startInboxWorker({
      journal,
      peer: 'home',
      pollseconds: 3600,
      apply: async (stream) => {
        if (stream.stream !== record.stream) return false;
        const applied = await replicas.apply(journal, stream);
        if (applied) {
          observations.accept({ kind: 'applied', peer: 'home', record });
        }
        return applied;
      },
      changed() {},
      failed(error, stream, after) {
        const event = facadeFailure(
          'inbox room',
          error,
          stream && applicationScope('home', stream, after),
        );
        observations.accept(event);
        attempt.resolve(event);
      },
    });
    assertEquals((await bounded(attempt.promise, 5000)).kind, 'blocked');
    assertEquals(finished, false);
    assertEquals(
      (await journal.heads('home', 'in', record)).applied.sequence,
      0,
    );
    assertEquals((await replicas.status(created.roomId))?.ready, false);
    const control = await exportKeyRoster(
      f.home,
      f.tenant,
      f.node.node,
      f.bundle.id,
      (_id, doc) => keys.cosign(doc),
    );
    await journal.receive('home', [control]);
    let calls = 0;
    const held: Database = {
      ...server,
      async tx(fn, options) {
        if (++calls === 2) {
          entered.resolve();
          await release.promise;
        }
        return server.tx(fn, options);
      },
    };
    applying = keys.apply(new Journal(held, LINK_CAPABILITIES), control);
    await bounded(entered.promise, 5000);
    attempt = Promise.withResolvers<ReturnType<typeof facadeFailure>>();
    worker.wake();
    assertEquals((await bounded(attempt.promise, 5000)).kind, 'blocked');
    assertEquals(finished, false);
    assertEquals(
      (await journal.heads('home', 'in', record)).applied.sequence,
      0,
    );
    assertEquals((await replicas.status(created.roomId))?.ready, false);
    release.resolve();
    await applying;
    worker.wake();
    assertEquals(await bounded(consumer, 5000), record);
    assertEquals(
      (await journal.heads('home', 'in', record)).applied.sequence,
      1,
    );
    assertEquals((await replicas.status(created.roomId))?.ready, true);
    const replica = await openRoom(f.edgeStore(), created.roomId);
    assertEquals(
      await replica.tx(async (tx) =>
        (await tx.events.getStatus(created.createEventId))?.standing
      ),
      'accepted',
    );
  } finally {
    release.resolve();
    await applying;
    await worker?.close();
    observations.close(new Error('test finished'));
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
      requireReadScope: (scope, absent) =>
        directory.requireReadScope(scope, absent),
      prepareReadRoomScope: (id, absent) =>
        directory.prepareReadRoomScope(id, absent),
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

Deno.test('facade membership admission: every local owner refuses unavailable scope before a result or signature', async (t) => {
  const f = await fixture();
  const raw = f.node.signer();
  let available = true, signatures = 0, revision = 0, retireOnSign = false;
  const checkCurrent = () => {
    if (!available) {
      throw new MatrixError(503, 'M_UNAVAILABLE', 'replica scope closed');
    }
  };
  const signer = {
    ...raw,
    sign: async (bytes: string) => {
      signatures++;
      const signature = await raw.sign(bytes);
      if (retireOnSign) revision++;
      return signature;
    },
  };
  try {
    setConfigForTests({
      server: { name: 'logical.test', role: 'facade' },
      facade: { phase: 'f2', nodeid: 'edge_a' },
    });
    const app = await openReplicaApp(f.edgeStore(), await f.edgeTenant(), {
      requireScope: () => Promise.resolve(),
      requireReadScope: () => Promise.resolve(),
      prepareReadRoomScope: () => Promise.reject(new Error('unused')),
      prepareRoomScope: async (_room, _absent, user) => {
        // Preparation is allowed to read server authority; room callbacks are not.
        await (await f.edgeServer()).query('SELECT 1');
        assert(user === '@alice:logical.test' || user === '@bob:logical.test');
        checkCurrent();
        const captured = revision;
        const current = () => {
          checkCurrent();
          if (captured !== revision) {
            throw new MatrixError(
              503,
              'M_UNAVAILABLE',
              'replica scope changed',
            );
          }
        };
        return {
          check: () => Promise.resolve(current()),
          checkCurrent: current,
        };
      },
      keys: keyStore(await f.edgeServer(), { signer }),
      signer,
      keyDocument: () => Promise.reject(new Error('unused')),
      publicRooms: () => Promise.resolve(false),
    });
    const user = '@alice:logical.test', target = '@bob:logical.test';
    const created = await createClientRoom({
      creator: user,
      preset: 'public_chat',
    });
    const room = await openRoom(app.store, created.roomId);
    await localMembership.invite(room, user, target, signer);
    await localMembership.ban(room, user, '@carol:logical.test', signer);
    let saved: PreparedSubmission | null = null;
    const submission = {
      lookup: () => Promise.resolve(saved),
      prepare: (pdu: Pdu) =>
        Promise.resolve(saved = { eventId: String(pdu.event_id), pdu }),
      finish: () => Promise.resolve(),
    };
    const member = {
      type: 'm.room.member',
      sender: user,
      state_key: user,
      content: { membership: 'join', displayname: 'retained member' },
    };
    const committed = await sendLocal(room, member, signer, submission);
    const committedHead = await room.tx((tx) => tx.changes.head());
    available = false;
    const before = signatures;
    await t.step('exact committed member receipt', async () => {
      const replay = await sendLocal(
        room,
        { ...member, content: { membership: 'leave' } },
        signer,
        submission,
      );
      assertEquals(replay.eventId, committed.eventId);
      assertEquals(replay.receipt, true);
      assertEquals(signatures, before);
      assertEquals(await room.tx((tx) => tx.changes.head()), committedHead);
    });
    const operations = {
      clientJoin: () => clientJoin(room.id, user),
      join: () => localMembership.join(room, user, signer),
      residentJoin: () => localMembership.joinResident(room, user, signer),
      reopen: () => localMembership.reopen(room, user, signer, {}),
      leave: () => localMembership.leave(room, user, signer),
      invite: () =>
        localMembership.invite(room, user, '@dave:logical.test', signer),
      kick: () => localMembership.kick(room, user, target, signer),
      ban: () => localMembership.ban(room, user, target, signer),
      unban: () =>
        localMembership.unban(room, user, '@carol:logical.test', signer),
      knock: () => localMembership.knock(room, user, signer),
    };
    for (const [name, operation] of Object.entries(operations)) {
      await t.step(name, async () => {
        await assertRejects(operation, MatrixError, 'replica scope closed');
        assertEquals(signatures, before);
      });
    }
    assertEquals(
      (await localMembership.membershipOf(room, user))?.membership,
      'join',
    );
    assertEquals(
      (await localMembership.membershipOf(room, target))?.membership,
      'invite',
    );
    assertEquals(
      (await localMembership.membershipOf(room, '@carol:logical.test'))
        ?.membership,
      'ban',
    );
    available = true;
    retireOnSign = true;
    for (
      const [name, operation] of Object.entries({
        join: () => localMembership.join(room, target, signer),
        leave: () => localMembership.leave(room, user, signer),
        authoredMember: () => localMembership.ban(room, user, target, signer),
      })
    ) {
      await t.step('commit fence ' + name, async () => {
        await assertRejects(operation, MatrixError, 'replica scope changed');
        assertEquals(
          (await localMembership.membershipOf(room, user))?.membership,
          'join',
        );
        assertEquals(
          (await localMembership.membershipOf(room, target))?.membership,
          'invite',
        );
      });
    }
    retireOnSign = false;
    await localMembership.leave(room, user, signer);
    retireOnSign = true;
    await assertRejects(
      () => localMembership.reopen(room, user, signer, {}),
      MatrixError,
      'replica scope changed',
    );
    assertEquals(
      (await localMembership.membershipOf(room, user))?.membership,
      'leave',
    );
    assertEquals(await room.tx((tx) => tx.segments.openStay()), null);
  } finally {
    await closeApp();
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('facade membership admission: a client join cannot return a stale projected join after a committed departure', async () => {
  const f = await fixture();
  try {
    setConfigForTests({
      server: { name: 'logical.test', role: 'facade' },
      facade: { phase: 'f2', nodeid: 'edge_a' },
    });
    const app = await openReplicaApp(f.edgeStore(), await f.edgeTenant(), {
      requireScope: () => Promise.resolve(),
      requireReadScope: () => Promise.resolve(),
      prepareReadRoomScope: () => Promise.reject(new Error('unused')),
      prepareRoomScope: () =>
        Promise.resolve({ check: () => Promise.resolve(), checkCurrent() {} }),
      keys: keyStore(await f.edgeServer(), { signer: f.node.signer() }),
      signer: f.node.signer(),
      keyDocument: () => Promise.reject(new Error('unused')),
      publicRooms: () => Promise.resolve(false),
    });
    const user = '@alice:logical.test';
    const created = await createClientRoom({
      creator: user,
      preset: 'public_chat',
    });
    const room = await openRoom(app.store, created.roomId);
    const previous = await localMembership.membershipOf(room, user);
    assert(previous);
    setRoomHooks({ project: () => Promise.resolve(), register: registerRoom });
    await localMembership.leave(room, user, app.tenant.signer());
    assertEquals(
      (await projectedMembershipOf(app.server, room.id, user))?.eventId,
      previous.eventId,
    );
    installServerHooks();
    const rejoined = await clientJoin(room.id, user);
    assertEquals(rejoined.created, true);
    assert(rejoined.eventId !== previous.eventId);
    assertEquals(
      (await localMembership.membershipOf(room, user))?.membership,
      'join',
    );
    assertEquals(
      (await projectedMembershipOf(app.server, room.id, user))?.eventId,
      rejoined.eventId,
    );
  } finally {
    installServerHooks();
    await closeApp();
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
      // This fixture isolates signer authority; membership now also prepares
      // its independent scope capability, which remains available here.
      prepareRoomScope: () =>
        Promise.resolve({ check: () => Promise.resolve(), checkCurrent() {} }),
      requireReadScope: () => Promise.resolve(),
      prepareReadRoomScope: () => Promise.reject(new Error('unused')),
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

Deno.test('client room dependencies preserve the App approved logical-server key owner', async () => {
  const f = await fixture();
  try {
    const owner = new FacadeKeys(
      await f.edgeServer(),
      f.node.signer(),
      f.node.publicKey,
      await f.edgePairings(),
    );
    const record = await exportKeyRoster(
      f.home,
      f.tenant,
      f.node.node,
      f.bundle.id,
      (_key, document) => owner.cosign(document),
    );
    const journal = await f.journal();
    await journal.receive('home', [record]);
    await owner.apply(journal, record);
    setConfigForTests({
      server: { name: 'logical.test', role: 'facade' },
      facade: { phase: 'f2', nodeid: 'edge_a' },
    });
    const app = await openReplicaApp(f.edgeStore(), await f.edgeTenant(), {
      requireScope: () => Promise.resolve(),
      prepareRoomScope: () => Promise.reject(new Error('unused')),
      requireReadScope: () => Promise.resolve(),
      prepareReadRoomScope: () => Promise.reject(new Error('unused')),
      keys: owner.verificationKeys(),
      signer: f.node.signer(),
      keyDocument: () => owner.document(),
      publicRooms: () => Promise.resolve(false),
    });
    const created = await createClientRoom({ creator: '@alice:logical.test' });
    const room = await openRoom(app.store, created.roomId);
    const join = await localMembership.membershipOf(
      room,
      '@alice:logical.test',
    );
    assert(join);
    const event = await room.tx((tx) => tx.events.get(join.eventId));
    assert(event);
    const args = {
      pdu: JSON.parse(event.pdu) as Pdu,
      roomVersion: await versionOf(room),
      server: 'logical.test',
      keyId: f.node.keyId,
      minValidUntilMs: Date.now(),
    };
    assert(await inviteDependencies(app).keys.verifyEventSignature(args));
    assert(await inviteDeps().keys.verifyEventSignature(args));
    // The same authority also verifies home-authored PDUs without self-HTTP.
    const homeCreated = await (await import('#engine/room/create.ts'))
      .createRoom(
        f.home,
        { creator: '@alice:logical.test' },
        f.tenant.signer(),
      );
    const homeRoom = await openRoom(f.home, homeCreated.roomId);
    const homeJoin = await localMembership.membershipOf(
      homeRoom,
      '@alice:logical.test',
    );
    assert(homeJoin);
    const homeEvent = await homeRoom.tx((tx) =>
      tx.events.get(homeJoin.eventId)
    );
    assert(homeEvent);
    assert(
      await inviteDeps().keys.verifyEventSignature({
        ...args,
        pdu: JSON.parse(homeEvent.pdu) as Pdu,
        keyId: f.tenant.keyId,
      }),
    );
  } finally {
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
      requireReadScope: () => Promise.resolve(),
      prepareReadRoomScope: () => Promise.reject(new Error('unused')),
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
  let delayed: import('#engine/delayed-events.ts').DelayedEvents | undefined;
  let delayedStops = 0, delayedWakes = 0;
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
      requireReadScope: () => Promise.resolve(),
      prepareReadRoomScope: () =>
        Promise.resolve({
          check: () => Promise.resolve(),
          checkCurrent: () => {},
        }),
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
      delayedEvents: async (granted: typeof tenant) => {
        assertEquals(granted.signer(), access.signer);
        const { DelayedEvents } = await import('#engine/delayed-events.ts');
        delayed = new DelayedEvents({ tenant: granted, store: f.edgeStore() });
        delayed.wake = () => {
          assertEquals(
            theApp().tenant,
            granted,
            'scheduler woke before app binding',
          );
          delayedWakes++;
        };
        delayed.stop = () => {
          delayedStops++;
          return Promise.resolve();
        };
        return delayed;
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
        await delayed?.stop();
        delayed = undefined;
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
    assertEquals(delayedWakes, 0);
    assertEquals(delayedStops, 1);
    const app = await openReplicaApp(f.edgeStore(), tenant, access);
    assertEquals(app.deviceLists, service);
    assertEquals(app.delayedEvents, delayed);
    assertEquals(delayedWakes, 1);
    assertEquals(attempts, 2);
    await closeApp();
    assertEquals(
      releases,
      1,
      'borrower does not stop successfully acquired owner services',
    );
    assertEquals(delayedStops, 1);
    await access.releaseServices();
    assertEquals(delayedStops, 2);
  } finally {
    await closeApp();
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('enrolled complete-list reads refuse missing inventory and missing room cuts', async (t) => {
  const f = await fixture();
  try {
    let profileReady = false;
    const profileReads: string[] = [];
    const tenant = await enrolledTenant(
      f.edgeStore(),
      await f.edgePairings(),
      'logical.test',
      f.node.node,
      {
        check(_conn, intent) {
          if (intent.kind === 'domain-read') {
            profileReads.push(intent.localpart);
            if (!profileReady) {
              throw new MatrixError(
                503,
                'M_UNAVAILABLE',
                'profile cut unavailable',
              );
            }
          }
          return Promise.resolve();
        },
      },
    );
    setConfigForTests({
      server: { name: 'logical.test', role: 'facade' },
      facade: { nodeid: 'edge_a' },
    });
    const directory = await f.directoryOwner();
    await openReplicaApp(f.edgeStore(), tenant, {
      requireReadScope: (scope, absent) =>
        directory.requireReadScope(scope, absent),
      prepareReadRoomScope: (id, absent) =>
        directory.prepareReadRoomScope(id, absent),
      requireScope: (scope, allowAbsent) =>
        directory.requireScope(scope, allowAbsent),
      prepareRoomScope: (roomId, allowAbsent) =>
        directory.prepareRoomScope(roomId, allowAbsent),
      keys: keyStore(await f.edgeServer(), { signer: f.node.signer() }),
      signer: f.node.signer(),
      keyDocument: () => Promise.reject(new Error('unused')),
      publicRooms: () => Promise.resolve(false),
    });
    const reads = [
      ['joined rooms', () => joinedRooms(f.source.creator)],
      ['user search', () => searchUsers(f.source.creator, 'absent')],
    ] as const;
    for (const [name, read] of reads) {
      await t.step(name + ' refuses missing directory', async () => {
        await assertRejects(read, MatrixError, 'replica unavailable');
      });
    }
    const inventory = await f.directoryExport();
    assert(inventory);
    const journal = await f.journal();
    await journal.receive('home', [inventory]);
    assert(await directory.apply(journal, inventory));
    for (const [name, read] of reads) {
      await t.step(name + ' refuses missing listed room', async () => {
        await assertRejects(read, MatrixError, 'replica unavailable');
      });
    }
    const room = await f.exports();
    assert(room);
    await journal.receive('home', [room]);
    assert(await (await f.replicas()).apply(journal, room));
    await directory.requireScope('rooms');
    await t.step(
      'user search admits candidate profiles through their domain owner',
      async () => {
        assertEquals(await searchUsers('@absent:logical.test', 'zoe'), {
          results: [],
          limited: false,
        });
        assertEquals(profileReads, ['zoe']);
        profileReady = true;
        const ready = await searchUsers('@absent:logical.test', 'zoe');
        assertEquals(ready.results.map((result) => result.user_id), [
          '@zoe:logical.test',
        ]);
        assertEquals(profileReads, ['zoe', 'zoe']);
      },
    );
    assertEquals(await joinedRooms(f.source.creator), [f.source.roomId]);
    assertEquals(await joinedRooms('@absent:logical.test'), []);
    assertEquals(await searchUsers(f.source.creator, 'absent'), {
      results: [],
      limited: false,
    });
  } finally {
    await closeApp();
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('client directory readers retain required-cut and known-absence distinctions', async (t) => {
  const f = await fixture();
  const alias = '#linked:logical.test';
  try {
    setConfigForTests({ server: { name: 'logical.test', role: 'facade' } });
    await registerAlias(
      await f.home.server(),
      alias,
      f.source.roomId,
      f.source.creator,
    );
    await setVisibility(await f.home.server(), f.source.roomId, 'public');
    const directory = await f.directoryOwner();
    await openReplicaApp(f.edgeStore(), await f.edgeTenant(), {
      requireReadScope: (scope, absent) =>
        directory.requireReadScope(scope, absent),
      prepareReadRoomScope: (id, absent) =>
        directory.prepareReadRoomScope(id, absent),
      requireScope: (scope, allowAbsent) =>
        directory.requireScope(scope, allowAbsent),
      prepareRoomScope: (roomId, allowAbsent) =>
        directory.prepareRoomScope(roomId, allowAbsent),
      keys: keyStore(await f.edgeServer(), { signer: f.node.signer() }),
      signer: f.node.signer(),
      keyDocument: () => Promise.reject(new Error('unused')),
      publicRooms: () => Promise.resolve(true),
    });
    const reads = [
      ['visibility', () => getVisibility(f.source.roomId)],
      ['alias', () => resolveAlias(alias)],
      ['room aliases', () => roomAliases(f.source.roomId, f.source.creator)],
      [
        'public rooms',
        () => listLocalPublishedRooms({ network: { kind: 'native' } }),
      ],
    ] as const;
    for (const [name, read] of reads) {
      await t.step(name + ' refuses absent directory', async () => {
        await assertRejects(read, MatrixError, 'replica unavailable');
      });
    }
    const inventory = await f.directoryExport();
    assert(inventory);
    const journal = await f.journal();
    await journal.receive('home', [inventory]);
    assert(await directory.apply(journal, inventory));
    for (const [name, read] of reads) {
      await t.step(name + ' refuses missing required room', async () => {
        await assertRejects(read, MatrixError, 'replica unavailable');
      });
    }
    const absent = await assertRejects(
      () => resolveAlias('#absent:logical.test'),
      MatrixError,
    );
    assertEquals(absent.status, 404);
    const room = await f.exports();
    assert(room);
    await journal.receive('home', [room]);
    assert(await (await f.replicas()).apply(journal, room));
    assertEquals(await getVisibility(f.source.roomId), {
      visibility: 'public',
    });
    assertEquals(await resolveAlias(alias), {
      room_id: f.source.roomId,
      servers: ['logical.test'],
    });
    assertEquals(await roomAliases(f.source.roomId, f.source.creator), [alias]);
    assertEquals(
      (await listLocalPublishedRooms({ network: { kind: 'native' } })).chunk
        .map((room) => room.room_id),
      [f.source.roomId],
    );
    const appliedReads = await Promise.all(reads.map(([, read]) => read()));
    await setVisibility(await f.home.server(), f.source.roomId, 'private');
    const next = await f.directoryExport();
    assert(next);
    await journal.receive('home', [next]);
    for (const [index, [name, read]] of reads.entries()) {
      await t.step(
        name + ' serves applied directory while successor is pending',
        async () => {
          assertEquals(await read(), appliedReads[index]);
        },
      );
    }
    assert(await directory.apply(journal, next));
    assertEquals(await roomAliases(f.source.roomId, f.source.creator), [alias]);
  } finally {
    await closeApp();
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('client typing admits the required replica before membership or ephemeral mutation', async () => {
  const { default: typingAdapter } = await import(
    new URL(
      '../api/endpoints/matrix/_matrix/client/v3/rooms/%23roomId/typing/%23userId/put.ts',
      import.meta.url,
    ).href
  ) as {
    default: (request: PathfinderRequest, context: Context) => Promise<unknown>;
  };
  const f = await fixture();
  try {
    setConfigForTests({ server: { name: 'logical.test', role: 'facade' } });
    const directory = await f.directoryOwner();
    await openReplicaApp(f.edgeStore(), await f.edgeTenant(), {
      requireReadScope: (scope, absent) =>
        directory.requireReadScope(scope, absent),
      prepareReadRoomScope: (id, absent) =>
        directory.prepareReadRoomScope(id, absent),
      requireScope: (scope, allowAbsent) =>
        directory.requireScope(scope, allowAbsent),
      prepareRoomScope: (roomId, allowAbsent) =>
        directory.prepareRoomScope(roomId, allowAbsent),
      keys: keyStore(await f.edgeServer(), { signer: f.node.signer() }),
      signer: f.node.signer(),
      keyDocument: () => Promise.reject(new Error('unused')),
      publicRooms: () => Promise.resolve(true),
    });
    const submit = (typing: boolean) => {
      const url = 'https://facade.test/_matrix/client/v3/rooms/' +
        encodeURIComponent(f.source.roomId) + '/typing/' +
        encodeURIComponent(f.source.creator);
      const bytes = new TextEncoder().encode(JSON.stringify({ typing }));
      return typingAdapter(
        {
          params: { roomId: f.source.roomId, userId: f.source.creator },
          method: 'PUT',
          _raw: new Request(url, { method: 'PUT' }),
          body: { bytes: () => Promise.resolve(bytes) },
        } as unknown as Parameters<typeof typingAdapter>[0],
        {
          state: { user: f.source.creator },
        } as unknown as Parameters<typeof typingAdapter>[1],
      );
    };
    const unavailable = async () => {
      const error = await assertRejects(() => submit(true), MatrixError);
      assertEquals(error.status, 503);
      assertEquals(error.errcode, 'M_UNAVAILABLE');
      assertEquals(typingIn(f.source.roomId).userIds, []);
    };
    await unavailable();
    const inventory = await f.directoryExport();
    assert(inventory);
    const journal = await f.journal();
    await journal.receive('home', [inventory]);
    assert(await directory.apply(journal, inventory));
    await unavailable();
    const record = await f.exports();
    assert(record);
    await journal.receive('home', [record]);
    assert(await (await f.replicas()).apply(journal, record));
    assertEquals(await submit(true), {});
    assertEquals(typingIn(f.source.roomId).userIds, [f.source.creator]);
    assertEquals(await submit(false), {});
    assertEquals(typingIn(f.source.roomId).userIds, []);
    await setVisibility(await f.home.server(), f.source.roomId, 'public');
    const next = await f.directoryExport();
    assert(next);
    await journal.receive('home', [next]);
    await unavailable();
    assert(await directory.apply(journal, next));
    assertEquals(await submit(true), {});
    assertEquals(typingIn(f.source.roomId).userIds, [f.source.creator]);
  } finally {
    await setTyping(
      await f.edgeServer(),
      f.source.roomId,
      f.source.creator,
      false,
    );
    await closeApp();
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('room event polling retains replica admission and local stream boundaries', async () => {
  const f = await fixture();
  try {
    setConfigForTests({ server: { name: 'logical.test', role: 'facade' } });
    const directory = await f.directoryOwner();
    await publicationIdentity(await f.edgeServer(), f.node.node);
    await openReplicaApp(f.edgeStore(), await f.edgeTenant(), {
      requireReadScope: (scope, absent) =>
        directory.requireReadScope(scope, absent),
      prepareReadRoomScope: (id, absent) =>
        directory.prepareReadRoomScope(id, absent),
      requireScope: (scope, allowAbsent) =>
        directory.requireScope(scope, allowAbsent),
      prepareRoomScope: (roomId, allowAbsent) =>
        directory.prepareRoomScope(roomId, allowAbsent),
      keys: keyStore(await f.edgeServer(), { signer: f.node.signer() }),
      signer: f.node.signer(),
      keyDocument: () => Promise.reject(new Error('unused')),
      publicRooms: () => Promise.resolve(true),
    });
    const poll = (from: string | null = null) =>
      roomEvents(
        f.source.roomId,
        f.source.creator,
        null,
        from,
        0,
        new AbortController().signal,
      );
    await assertRejects(poll, MatrixError, 'replica unavailable');
    const inventory = await f.directoryExport();
    assert(inventory);
    const journal = await f.journal();
    await journal.receive('home', [inventory]);
    assert(await directory.apply(journal, inventory));
    await assertRejects(poll, MatrixError, 'replica unavailable');
    const record = await f.exports();
    assert(record);
    await journal.receive('home', [record]);
    assert(await (await f.replicas()).apply(journal, record));
    const initial = await roomInitialSync(
      f.source.roomId,
      f.source.creator,
      null,
      10,
    );
    assertEquals(initial.room_id, f.source.roomId);
    assertEquals(initial.membership, 'join');
    const empty = await poll(initial.messages.end);
    assertEquals(empty.chunk, []);
    assertEquals(empty.start, initial.messages.end);
    const foreign = formatStreamToken(
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      undefined,
      undefined,
      crypto.randomUUID(),
    );
    const rejected = await assertRejects(() => poll(foreign), MatrixError);
    assertEquals(rejected.status, 400);
    assertEquals(rejected.errcode, 'M_UNKNOWN_POS');
    const global = await assertRejects(
      () =>
        roomEvents(
          '',
          f.source.creator,
          null,
          null,
          0,
          new AbortController().signal,
        ),
      MatrixError,
    );
    assertEquals(global.status, 400);
    assertEquals(global.errcode, 'M_INVALID_PARAM');
    await assertRejects(() => poll('s0'), MatrixError, 'foreign sync position');
    await assertRejects(() => poll('invalid'), MatrixError, 'bad from token');
    await assertRejects(
      () =>
        roomEvents(
          '!absent:logical.test',
          f.source.creator,
          null,
          null,
          0,
          new AbortController().signal,
        ),
      MatrixError,
      'room not found',
    );
    await setVisibility(await f.home.server(), f.source.roomId, 'public');
    const next = await f.directoryExport();
    assert(next);
    await journal.receive('home', [next]);
    assertEquals((await poll(empty.end)).chunk, []);
    assert(await directory.apply(journal, next));
    assertEquals((await poll(empty.end)).chunk, []);
  } finally {
    await closeApp();
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('PAIR503: event lookup and ACL answer follow the current replica cut', async (t) => {
  const f = await fixture();
  const readiness = new ReplicaReadiness({
    canDeliver: () => false,
    onDeliveryLoss: () => () => {},
  });
  try {
    const server = await f.edgeServer(), pairings = await f.edgePairings();
    const journal = new Journal(
      server,
      LINK_CAPABILITIES,
      (_, stream) => readiness.receiving(stream.incarnation, stream.stream),
    );
    const directory = new DirectoryReplicas(
      server,
      pairings,
      f.tenant.serverName,
      'f1',
      readiness,
    );
    const rooms = await f.replicas();
    const apply = async (
      record: NonNullable<Awaited<ReturnType<typeof f.exports>>>,
    ) => {
      assert(await rooms.apply(journal, record));
      readiness.applied(record.incarnation, record.stream);
    };
    const initial = await f.exports(), inventory = await f.directoryExport();
    assert(initial && inventory);
    await journal.receive('home', [initial]);
    await apply(initial);
    await journal.receive('home', [inventory]);
    assert(await directory.apply(journal, inventory));
    const tenant = await f.edgeTenant();
    setConfigForTests({
      server: { name: 'logical.test', role: 'facade' },
      facade: { nodeid: 'edge_a' },
    });
    await openReplicaApp(f.edgeStore(), tenant, {
      requireReadScope: (scope, absent) =>
        directory.requireReadScope(scope, absent),
      prepareReadRoomScope: (id, absent) =>
        directory.prepareReadRoomScope(id, absent),
      requireScope: (scope, absent, signal) =>
        directory.requireScope(scope, absent, signal),
      prepareRoomScope: (id, absent) => directory.prepareRoomScope(id, absent),
      keys: keyStore(server, { signer: f.node.signer() }),
      signer: f.node.signer(),
      keyDocument: () => Promise.reject(new Error('unused')),
      publicRooms: async () => (await directory.snapshot())!.publicRooms,
    });

    const message = await f.source.addEvent({
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: 'new publication' },
    });
    await f.ingest([message]);
    const eventId = String(message.event_id);
    const suffix = await f.exports();
    assert(suffix);
    await journal.receive('home', [suffix]);
    const entered = Promise.withResolvers<void>();
    await t.step(
      'a not-yet-indexed event becomes visible after apply',
      async () => {
        const signal = AbortSignal.timeout(5000);
        const answer = serveEvent(eventId, f.signing.name, {
          store: f.edgeStore(),
          server,
          self: f.tenant.serverName,
          withCurrentScopes: (read) =>
            directory.withCurrentScopes(
              (requireScope) =>
                read(async (scope) => {
                  try {
                    await requireScope(scope);
                  } finally {
                    if (scope === 'rooms') entered.resolve();
                  }
                }),
              signal,
            ),
        });
        const result = answer.then((value) => value, (error: unknown) => error);
        await bounded(entered.promise, 1000);
        assertEquals(await roomOf(server, eventId), null);
        await apply(suffix);
        const found = await result;
        if (found instanceof Error) throw found;
        assertEquals(
          (found as Awaited<typeof answer>).pdus[0].content,
          message.content,
        );
      },
    );

    await t.step(
      'an ACL publication replaces a stale success before reply',
      async () => {
        const acl = await f.source.addEvent({
          type: 'm.room.server_acl',
          state_key: '',
          content: { allow: ['*'], deny: [f.signing.name] },
        });
        await f.ingest([acl]);
        const suffix = await f.exports();
        assert(suffix);
        let reads = 0;
        await assertRejects(
          () =>
            serveEvent(eventId, f.signing.name, {
              store: f.edgeStore(),
              server,
              self: f.tenant.serverName,
              withCurrentScopes: (read) =>
                directory.withCurrentScopes(async (requireScope) => {
                  reads++;
                  const value = await read(requireScope);
                  assertEquals(reads, 1);
                  await journal.receive('home', [suffix]);
                  await apply(suffix);
                  return value;
                }, AbortSignal.timeout(5000)),
            }),
          MatrixError,
          'ACL',
        );
        assertEquals(reads, 2);
      },
    );
  } finally {
    readiness.close();
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
      requireReadScope: (scope, absent) =>
        directory.requireReadScope(scope, absent),
      prepareReadRoomScope: (id, absent) =>
        directory.prepareReadRoomScope(id, absent),
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
    assertEquals(
      await restrictedKnowledge(app.store, f.source.roomId),
      'partial',
    );
    assertEquals(
      await restrictedKnowledge(app.store, '!unselected:logical.test'),
      'unavailable',
      'a missing local allowed room on this replica is not complete nonmembership',
    );
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
          requireReadScope: (scope, absent) =>
            directory.requireReadScope(scope, absent),
          prepareReadRoomScope: (id, absent) =>
            directory.prepareReadRoomScope(id, absent),
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

Deno.test('PAIR503: public federation reads serve the applied publication', async (t) => {
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
      requireReadScope: (scope, absent) =>
        directory.requireReadScope(scope, absent),
      prepareReadRoomScope: (id, absent) =>
        directory.prepareReadRoomScope(id, absent),
      requireScope: (scope, allowAbsent) =>
        directory.requireScope(scope, allowAbsent),
      prepareRoomScope: (roomId, allowAbsent) =>
        directory.prepareRoomScope(roomId, allowAbsent),
      keyDocument: () =>
        Promise.reject(new Error('unused key-document callback')),
      keys: keyStore(await f.edgeServer(), { signer: f.node.signer() }),
      signer: f.node.signer(),
      publicRooms: async () =>
        (await directory.snapshot('applied'))!.publicRooms,
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
    assert(await directory.apply(journal, next));
    await f.tenant.tx((tx) =>
      tx.profiles.set('alice', 'displayname', 'New Alice')
    );
    const newUser = await f.publicExport();
    assert(newUser);
    setConfigForTests({
      server: { name: 'logical.test' },
      federation: { enabled: true, mode: 'open', publicrooms: false },
    });
    const newInventory = await f.directoryExport();
    assert(newInventory);
    await journal.receive('home', [newUser]);
    await journal.receive('home', [newInventory]);
    const readers = [
      { name: 'profile', get: () => call('GET', profile) },
      { name: 'alias', get: () => call('GET', alias) },
      { name: 'devices', get: () => call('GET', devices) },
      {
        name: 'keys query',
        get: () => call('POST', p + 'user/keys/query', query),
      },
    ];
    for (const { name, get } of readers) {
      await t.step(name, async () => {
        const result = await get();
        assertEquals(result.status, 200, JSON.stringify(result.body));
        if (name === 'profile') {
          assertEquals(result.body, { displayname: 'Linked Alice' });
        } else if (name === 'alias') {
          assertEquals(result.body, {
            room_id: f.source.roomId,
            servers: ['logical.test'],
          });
        }
      });
    }
    for (const method of ['GET', 'POST'] as const) {
      await t.step(method + ' publicRooms', async () => {
        const result = await call(
          method,
          p + 'publicRooms',
          method === 'POST' ? {} : undefined,
        );
        assertEquals(result.status, 200, JSON.stringify(result.body));
        assertEquals(
          (result.body.chunk as { room_id: string }[]).map((room) =>
            room.room_id
          ),
          [f.source.roomId],
        );
      });
    }
    assert(await directory.apply(journal, newInventory));
    assert(await (await f.publicOwner()).apply(journal, newUser));
    assertEquals((await call('GET', p + 'publicRooms')).status, 403);
    assertEquals(await call('GET', profile), {
      status: 200,
      body: { displayname: 'New Alice' },
    });
  } finally {
    await http?.shutdown();
    await closeApp();
    setConfigForTests({});
    await f.close();
  }
});

Deno.test('CHECKLISTSLOW: only a returned unapplied directory room waits', async () => {
  const f = await fixture();
  const observed = Promise.withResolvers<void>();
  const readiness = new ReplicaReadiness({
    canDeliver: () => {
      observed.resolve();
      return true;
    },
    onDeliveryLoss: () => () => {},
  });
  const abort = new AbortController();
  let result: Promise<unknown> | undefined;
  try {
    const server = await f.edgeServer();
    const directory = new DirectoryReplicas(
      server,
      await f.edgePairings(),
      f.tenant.serverName,
      'f1',
      readiness,
    );
    const journal = new Journal(
      server,
      LINK_CAPABILITIES,
      (_, stream) => readiness.receiving(stream.incarnation, stream.stream),
    );
    const rooms = await f.replicas();
    const pending = await makeFakeRoom({
      roomId: '!z-pending:logical.test',
      server: f.signing,
      version: f.source.version,
    });
    const [create, join] = pending.events.values();
    const keys = fakeKeyResolver(f.signing);
    await importReplicaGenesis(f.home, {
      roomId: pending.roomId,
      roomVersion: pending.version,
      self: f.signing.name,
      keys,
      create,
      join,
    });
    const home = await f.home.server();
    await setVisibility(home, f.source.roomId, 'public');
    await setVisibility(home, pending.roomId, 'public');
    const initial = await f.exports(), inventory = await f.directoryExport();
    const delayed = await exportRoomReplica(
      f.home,
      await openRoom(f.home, pending.roomId),
      f.signing.name,
      f.node.node,
      f.bundle.id,
    );
    assert(initial && inventory && delayed);
    await journal.receive('home', [initial]);
    await journal.receive('home', [inventory]);
    assert(await rooms.apply(journal, initial));
    assert(await directory.apply(journal, inventory));
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]);
    const first = await directory.rankedDirectoryPage(0, 1, signal);
    assertEquals(first.total, 2);
    assertEquals(first.rooms.map(({ id }) => id), [f.source.roomId]);
    let completed = false;
    const page = directory.rankedDirectoryPage(1, 1, signal).finally(() => {
      completed = true;
    });
    result = page;
    await Promise.race([observed.promise, page]);
    assert(!completed, 'the selected unapplied room should wait');
    await journal.receive('home', [delayed]);
    assert(await rooms.apply(journal, delayed));
    readiness.applied(delayed.incarnation, delayed.stream);
    assertEquals(await page, {
      total: 2,
      rooms: [{
        id: pending.roomId,
        joined: (await joinedUsers(server, pending.roomId)).length,
      }],
    });
  } finally {
    abort.abort();
    await result?.catch(() => {});
    readiness.close();
    await f.close();
  }
});

appliedReadTests();
