import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  closeApp,
  openReplicaApp,
  startFederationServices,
  theApp,
} from '#engine/app.ts';
import { setConfigForTests } from '#engine/config.ts';
import { serveDeps } from '#engine/federation/context.ts';
import { serveEvent } from '#engine/federation/serve.ts';
import { admit } from '#engine/federation/gate.ts';
import { federationPolicy } from '#engine/federation/policy.ts';
import { enrolledTenant, initializeNode } from '#engine/facade/identity.ts';
import { exportPublicReplica, PublicReplicas } from '#engine/facade/public.ts';
import {
  DirectoryReplicas,
  exportDirectoryReplica,
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
import { Journal } from '#engine/facade/journal.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { LINK_CAPABILITIES } from '#engine/facade/protocol.ts';
import {
  exportRoomReplica,
  RoomReplicas,
  startRoomExports,
} from '#engine/facade/replication.ts';
import { bounded } from './helpers/server-process.ts';
import type { Pdu } from '#engine/pdu.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { importReplicaGenesis } from '#engine/room/replica.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { roomOf } from '#engine/server/read.ts';
import { recoverServer } from '#engine/server/startup.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
} from './fixtures/remote.ts';
import { makeFakeRoom } from './fixtures/remote-room.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-replication-' });
  const open = (name: string) =>
    openStore({
      dir: dir + '/' + name,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, {
      schemas: { server: serverSchema, tenant: tenantSchema, room: roomSchema },
    });
  const home = await open('home');
  let edge = await open('edge');
  const tenant = await openTenant(home, 'logical.test', { create: true });
  const node = await initializeNode(
    await edge.server(),
    tenant.serverName,
    'edge_a',
  );
  const hp = new Pairings(
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
    home,
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
          'DROP TABLE federation_policy; DROP TABLE facade_scopes; DROP TABLE facade_exports',
        );
        await conn.execute("UPDATE meta SET v='29' WHERE k='schema_version'");
      }, { mode: 'deferred' });
    },
    async reopen() {
      await edge.close();
      edge = await open('edge');
    },
    async close() {
      await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

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
  const f = await fixture();
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

Deno.test('enrolled replica app composes ordinary reads and recovery without creating home-only workers or a home identity', async () => {
  const f = await fixture();
  try {
    const record = await f.exports();
    assert(record);
    const journal = await f.journal();
    await journal.receive('home', [record]);
    assert(await (await f.replicas()).apply(journal, record));
    const tenant = await f.edgeTenant();
    setConfigForTests({
      server: { name: 'logical.test', role: 'facade' },
      facade: { nodeid: 'edge_a' },
    });
    const directory = await f.directoryOwner();
    const app = await openReplicaApp(f.edgeStore(), tenant, {
      requireScope: (scope) => directory.requireScope(scope),
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
