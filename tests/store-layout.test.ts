// tests/store-layout.test.ts — key derivation, the recorded id contract and
// the server file's forward-only watermarks with ordered startup hooks.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { createDatabase } from '#engine/store/create.ts';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import {
  checkId,
  databaseFiles,
  directory,
  keyFor,
  recordId,
  serverDirectory,
} from '#engine/store/layout.ts';
import {
  advance,
  ensureWatermarks,
  get,
  onStartup,
  sources,
  startupHooks,
} from '#engine/store/watermark.ts';

Deno.test('store layout: key derivation and directory shape', async () => {
  // RFC 6234 vector: sha-256 of 'abc'.
  assertEquals(await keyFor('abc'), 'ba7816bf8f01cfea414140de5dae2223');
  const key = await keyFor('!room:example.org');
  assert(/^[0-9a-f]{32}$/.test(key), `key is not 32 lowercase hex: ${key}`);
  assertEquals(await keyFor('!room:example.org'), key);
  assertNotEqualsKeys(await keyFor('!a:test'), await keyFor('!b:test'));
  assertEquals(directory('/store', 'rooms', key), `/store/rooms/${key}`);
  assertEquals(directory('/store', 'tenants', key), `/store/tenants/${key}`);
  assertEquals(serverDirectory('/store'), '/store/server');
  assertEquals(databaseFiles('/store/rooms/k'), {
    database: '/store/rooms/k/data.db',
    log: '/store/rooms/k/data.db-log',
    wal: '/store/rooms/k/data.db-wal',
  });
});

function assertNotEqualsKeys(a: string, b: string): void {
  assert(a !== b, `distinct ids must not share a key: ${a}`);
}

Deno.test('store layout: the recorded id is checked on open', async () => {
  const parent = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  try {
    const dir = await createDatabase(ffi, parent, 'room', {
      checkpointlogbytes: 65536,
      schema: (db) => recordId(db, '!room:test'),
      verify: (db) => checkId(db, '!room:test'),
    });
    const db = await Db.open(ffi, databaseFiles(dir).database, 65536);
    try {
      await checkId(db, '!room:test');
      await assertRejects(
        () => checkId(db, '!other:test'),
        Error,
        'database id mismatch',
      );
    } finally {
      await db.close();
    }
    ffi.close();
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test('store watermark: only forward, per source, inside the caller transaction', async () => {
  const dir = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  try {
    const db = await Db.open(ffi, databaseFiles(dir).database, 65536);
    try {
      await ensureWatermarks(db);
      assertEquals(await get(db, 'room:!a:test'), 0);
      await db.tx((tx) => advance(tx, 'room:!a:test', 5));
      assertEquals(await get(db, 'room:!a:test'), 5);
      await db.tx(async (tx) => {
        await advance(tx, 'room:!a:test', 3);
        await advance(tx, 'room:!a:test', 5);
      });
      assertEquals(await get(db, 'room:!a:test'), 5);
      await db.tx((tx) => advance(tx, 'room:!a:test', 9));
      assertEquals(await get(db, 'room:!a:test'), 9);
      await db.tx((tx) => advance(tx, 'tenant:@b:test', 2));
      assertEquals(await sources(db), ['room:!a:test', 'tenant:@b:test']);
      assertEquals(await get(db, 'tenant:@b:test'), 2);
      await assertRejects(
        () => db.tx((tx) => advance(tx, 'room:!a:test', -1)),
        TypeError,
      );
      assertEquals(await get(db, 'room:!a:test'), 9);
    } finally {
      await db.close();
    }
    ffi.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store watermark: startup hooks run in registration order', async () => {
  const order: number[] = [];
  for (let index = 0; index < 3; index++) {
    onStartup((store) => {
      assert(store !== undefined, 'startup hooks receive the opening store');
      order.push(index);
      return Promise.resolve();
    });
  }
  const store = {} as Parameters<ReturnType<typeof startupHooks>[number]>[0];
  for (const hook of startupHooks()) await hook(store);
  assertEquals(order, [0, 1, 2]);
});
