import { assert, assertEquals, assertRejects } from '@std/assert';
import { initializeNode } from '#engine/facade/identity.ts';
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
    async retire() {
      await (await edge.server()).execute(
        "UPDATE facade_pairings SET state='revoked' WHERE id=?",
        [bundle.id],
      );
    },
    replica: () => openRoom(edge, source.roomId),
    async downgrade() {
      await (await edge.server()).tx(async (conn) => {
        await conn.exec('DROP TABLE facade_scopes; DROP TABLE facade_exports');
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
