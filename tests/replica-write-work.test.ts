import { assertEquals, assertRejects } from '@std/assert';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import type { SchemaProvider } from '#engine/store/create.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installPublicUser } from '#engine/tenant/public-replica.ts';
import { profileRow } from '#engine/tenant/profiles.ts';
import {
  exportDirectoryFacts,
  installDirectoryFacts,
} from '#engine/server/public-replica.ts';
import {
  installPeerPolicy,
  peerPolicyOf,
} from '#engine/federation/policy-replica.ts';

async function fixture(schema: SchemaProvider, fn: (db: Db) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const db = await Db.open(ffi, dir + '/data.db', 65536);
  try {
    await schema.apply(db);
    await fn(db);
  } finally {
    await db.close();
    ffi.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function measure(db: Db, owner: string, fn: () => Promise<void>) {
  const execute = db.ffi.execute.bind(db.ffi);
  const writes: Record<string, number> = {};
  db.ffi.execute = async (...args: Parameters<Turso['execute']>) => {
    const n = await execute(...args);
    const table = /^(?:INSERT INTO|UPDATE|DELETE FROM) (\w+)/.exec(args[1])
      ?.[1];
    if (table) writes[table] = (writes[table] ?? 0) + n;
    return n;
  };
  const start = performance.now();
  try {
    await fn();
  } finally {
    db.ffi.execute = execute;
  }
  console.log(
    JSON.stringify({ owner, writes, elapsed_ms: performance.now() - start }),
  );
  return writes;
}

Deno.test('replica work: public user cut progress does not replace equal profile and erasure material', () =>
  fixture(tenantSchema, async (db) => {
    const profile = {
      displayname: 'Alice',
      avatar_url: 'mxc://logical.test/a',
      ...Object.fromEntries(
        Array.from({ length: 32 }, (_, i) => ['example.k' + i, { a: 1, b: 2 }]),
      ),
    };
    const view = {
      version: 1,
      userId: '@alice:logical.test',
      cut: 1,
      deactivated: false,
      profile,
      erased: { '!r:logical.test': { changePos: 3, segment: 1, group: 2 } },
      devices: { user_id: '@alice:logical.test', stream_id: 1, devices: [] },
      signing: {},
    };
    await db.tx((tx) => installPublicUser(tx, view, 'logical.test'));
    const next = {
      ...view,
      cut: 2,
      profile: { ...profile, 'example.k0': { b: 2, a: 1 } },
    };
    const writes = await measure(
      db,
      'public user new cut equal material',
      () => db.tx((tx) => installPublicUser(tx, next, 'logical.test')),
    );
    assertEquals(await db.tx((tx) => profileRow(tx, 'alice')), profile);
    assertEquals(writes.users ?? 0, 0);
    assertEquals(writes.profile_fields ?? 0, 0);
    assertEquals(writes.erased_users ?? 0, 0);
    assertEquals(writes.public_user_replicas, 1);
    const replay = await measure(
      db,
      'public user same cut replay',
      () => db.tx((tx) => installPublicUser(tx, next, 'logical.test')),
    );
    assertEquals(Object.values(replay).reduce((a, b) => a + b, 0), 0);
    const changed: Record<string, unknown> = {
      ...profile,
      displayname: null,
      'example.k0': null,
    };
    delete changed['example.k1'];
    const delta = await measure(
      db,
      'public user material delta',
      () =>
        db.tx((tx) =>
          installPublicUser(tx, {
            ...next,
            cut: 3,
            profile: changed,
            erased: null,
          }, 'logical.test')
        ),
    );
    const expected = { ...changed };
    delete expected.displayname;
    assertEquals(await db.tx((tx) => profileRow(tx, 'alice')), expected);
    assertEquals(delta.users, 1);
    assertEquals(delta.profile_fields, 2);
    assertEquals(delta.erased_users, 1);
    await assertRejects(() =>
      db.tx((tx) =>
        installPublicUser(tx, {
          ...next,
          cut: 4,
          profile: { 'example.bad': 'x'.repeat(65536) },
        }, 'logical.test')
      )
    );
    assertEquals(await db.tx((tx) => profileRow(tx, 'alice')), expected);
  }));

Deno.test('replica work: directory authoritative replacement writes only set differences and nullable changes', () =>
  fixture(serverSchema, async (db) => {
    const facts = {
      aliases: Array.from(
        { length: 32 },
        (_, i) => ({
          alias: '#a' + i + ':logical.test',
          roomId: '!r' + i + ':logical.test',
          creator: null,
        }),
      ),
      publication: Array.from(
        { length: 32 },
        (_, i) => ({
          roomId: '!r' + i + ':logical.test',
          visibility: 'public' as const,
          purgeable: null,
        }),
      ),
      forgotten: Array.from(
        { length: 32 },
        (_, i) => ({
          user: '@a:logical.test',
          roomId: '!r' + i + ':logical.test',
        }),
      ),
    };
    await db.tx((tx) => installDirectoryFacts(tx, facts, 'logical.test'));
    const writes = await measure(
      db,
      'directory equal snapshot',
      () => db.tx((tx) => installDirectoryFacts(tx, facts, 'logical.test')),
    );
    assertEquals(Object.values(writes).reduce((a, b) => a + b, 0), 0);
    const next = {
      ...facts,
      aliases: [
        { ...facts.aliases[0], creator: '@a:logical.test' },
        ...facts.aliases.slice(2),
      ],
      publication: [
        { ...facts.publication[0], purgeable: 4 },
        ...facts.publication.slice(2),
      ],
      forgotten: facts.forgotten.slice(1),
    };
    const delta = await measure(
      db,
      'directory material delta',
      () => db.tx((tx) => installDirectoryFacts(tx, next, 'logical.test')),
    );
    assertEquals(delta, {
      aliases: 2,
      visibility: 1,
      directory: 2,
      forgotten: 1,
    });
    assertEquals(
      await db.tx((tx) => exportDirectoryFacts(tx, 'logical.test')),
      {
        ...next,
        aliases: next.aliases.toSorted((a, b) =>
          a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0
        ),
        publication: next.publication.toSorted((a, b) =>
          a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0
        ),
        forgotten: next.forgotten.toSorted((a, b) =>
          a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0
        ),
      },
    );
    await db.tx((tx) =>
      installDirectoryFacts(
        tx,
        { aliases: [], publication: [], forgotten: [] },
        'logical.test',
      )
    );
    assertEquals(
      await db.tx((tx) => exportDirectoryFacts(tx, 'logical.test')),
      {
        aliases: [],
        publication: [],
        forgotten: [],
      },
    );
  }));

Deno.test('replica work: peer policy retains reconciliation and clears annotations without replacing equal peers', () =>
  fixture(serverSchema, async (db) => {
    const policy = peerPolicyOf({
      federation: {
        enabled: true,
        mode: 'open',
        keychange: 'warn',
        witnesses: 1,
        keyfailminutes: 1,
        keyvalidityhours: 1,
        paused: [],
      },
      keyDecisions: [],
      peers: Array.from(
        { length: 32 },
        (_, i) => ({
          name: 'p' + i + '.test',
          host: null,
          port: null,
          trust: 'ca',
          pin: null,
          added: 1,
          by: 'home',
        }),
      ),
      blocks: Array.from(
        { length: 32 },
        (_, i) => ({ pattern: 'b' + i + '.test', added: 1 }),
      ),
    });
    await db.tx((tx) => installPeerPolicy(tx, policy));
    const writes = await measure(
      db,
      'peer policy equal snapshot',
      () => db.tx((tx) => installPeerPolicy(tx, policy)),
    );
    assertEquals(Object.values(writes).reduce((a, b) => a + b, 0), 0);
    await db.execute(
      "UPDATE federation_peers SET note='local annotation' WHERE name='p0.test'",
    );
    await db.execute(
      "UPDATE federation_blocks SET note='local annotation' WHERE pattern='b0.test'",
    );
    await db.execute(
      "INSERT INTO federation_pending(name,kind,verified,first_ms,last_ms,count) VALUES('p0.test','inbound',1,1,1,1)",
    );
    const reconcile = await measure(
      db,
      'peer policy annotation and pending reconciliation',
      () => db.tx((tx) => installPeerPolicy(tx, policy)),
    );
    assertEquals(reconcile.federation_peers, 1);
    assertEquals(reconcile.federation_blocks, 1);
    assertEquals(reconcile.federation_pending, 1);
    assertEquals(await db.query('SELECT * FROM federation_pending'), []);
    const next = {
      ...policy,
      peers: [
        { ...policy.peers[0], host: 'route.test' },
        ...policy.peers.slice(2),
      ],
      blocks: policy.blocks.slice(1),
    };
    const delta = await measure(
      db,
      'peer policy material delta',
      () => db.tx((tx) => installPeerPolicy(tx, next)),
    );
    assertEquals(delta.federation_peers, 2);
    assertEquals(delta.federation_blocks, 1);
    assertEquals(
      (await db.query('SELECT host,note FROM federation_peers WHERE name=?', [
        'p0.test',
      ]))[0],
      { host: 'route.test', note: null },
    );
  }));
