import { assert, assertEquals, assertRejects } from '@std/assert';
import { Db } from '#engine/store/db.ts';
import { openStore } from '#engine/store/index.ts';
import { Turso } from '#engine/store/ffi.ts';
import { keyFor } from '#engine/store/layout.ts';
import { integrityCheck } from '#engine/store/create.ts';

function latch() {
  let release!: () => void;
  return {
    wait: new Promise<void>((resolve) => release = resolve),
    release: () => release(),
  };
}

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: 'snapshot-lifecycle-' });
  const store = await openStore({
    dir: root + '/live',
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 2,
    idleseconds: 3600,
  });
  return { root, store };
}

Deno.test('store snapshot: retained removal waits outside admission needed by another cut', async () => {
  const { root, store } = await fixture();
  const id = '!recreated:test';
  const old = await store.room(id, { create: true });
  await old.exec('CREATE TABLE content(value TEXT)');
  await old.execute('INSERT INTO content VALUES(?)', ['old incarnation']);
  const prepare = Db.prototype.prepareReadSnapshot;
  const exporting = latch(), resume = latch();
  let intercepted = false;
  Db.prototype.prepareReadSnapshot = async function () {
    const prepared = await prepare.call(this);
    return {
      ...prepared,
      pin: async () => {
        const reader = await prepared.pin();
        return {
          ...reader,
          export: async (path) => {
            if (!intercepted && this.path === root + '/live/server/data.db') {
              intercepted = true;
              exporting.release();
              await resume.wait;
            }
            await reader.export(path);
          },
        };
      },
    };
  };
  let first: ReturnType<typeof store.snapshot> | undefined;
  let second: ReturnType<typeof store.snapshot> | undefined;
  let removal: Promise<void> | undefined;
  try {
    first = store.snapshot(root + '/first');
    await exporting.wait;
    removal = store.removeRoom(id);
    while (!(await store.roomRetired(id))) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    let completed = false;
    second = store.snapshot(root + '/second').then((cut) => {
      completed = true;
      return cut;
    });
    await Promise.race([
      second,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    assert(
      completed,
      'removal retained admission and deadlocked the next common cut',
    );
    const active = await store.room('!created-during-export:test', {
      create: true,
    });
    await active.exec('CREATE TABLE traffic(body TEXT)');
    await active.execute('INSERT INTO traffic VALUES(?)', ['x'.repeat(70000)]);
    resume.release();
    await first;
    await removal;
    await assertRejects(
      () => old.query('SELECT * FROM content'),
      Deno.errors.NotFound,
    );
    const replacement = await store.room(id, { create: true });
    await replacement.exec('CREATE TABLE content(value TEXT)');
    await replacement.execute('INSERT INTO content VALUES(?)', [
      'new incarnation',
    ]);
    await store.snapshot(root + '/third');
    const ffi = new Turso('./.native/libturso_ffi.so');
    try {
      for (
        const [label, value] of [['first', 'old incarnation'], [
          'second',
          'old incarnation',
        ], ['third', 'new incarnation']]
      ) {
        const db = await Db.open(
          ffi,
          root + '/' + label + '/rooms/' + await keyFor(id) + '/data.db',
          65536,
        );
        try {
          await integrityCheck(db);
          assertEquals(await db.query('SELECT * FROM content'), [{ value }]);
        } finally {
          await db.close();
        }
      }
    } finally {
      ffi.close();
    }
  } finally {
    resume.release();
    await Promise.allSettled([first, second, removal]);
    Db.prototype.prepareReadSnapshot = prepare;
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store snapshot: actual over-cache population includes every inactive source', async () => {
  const { root, store } = await fixture();
  try {
    for (let n = 0; n < 257; n++) {
      await store.room('!over-cache-' + n + ':test', { create: true });
    }
    await store.tenant('inactive.test', { create: true });
    assert(store.stats().openFiles <= 2);
    const cut = await store.snapshot(root + '/out');
    assertEquals(cut.files.length, 259);
    const ffi = new Turso('./.native/libturso_ffi.so');
    try {
      for (const file of cut.files) {
        const db = await Db.open(ffi, root + '/out/' + file.path, 65536);
        try {
          await integrityCheck(db);
          if (file.id !== null) {
            assertEquals(await db.query('SELECT value FROM id'), [{
              value: file.id,
            }]);
          }
        } finally {
          await db.close();
        }
      }
    } finally {
      ffi.close();
    }
  } finally {
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store snapshot: pin and export failures release all native and lifecycle holds', async (test) => {
  for (const phase of ['pin', 'export']) {
    await test.step(phase, async () => {
      const { root, store } = await fixture();
      const id = '!failed:test';
      await store.room(id, { create: true });
      const prepare = Db.prototype.prepareReadSnapshot;
      Db.prototype.prepareReadSnapshot = async function () {
        const prepared = await prepare.call(this);
        if (!this.path.includes('/rooms/')) return prepared;
        return {
          ...prepared,
          pin: async () => {
            if (phase === 'pin') throw new Error('injected pin failure');
            const reader = await prepared.pin();
            return {
              ...reader,
              export: () =>
                Promise.reject(new Error('injected export failure')),
            };
          },
        };
      };
      try {
        await assertRejects(
          () => store.snapshot(root + '/failed'),
          Error,
          'injected ' + phase + ' failure',
        );
        await assertRejects(
          () => Deno.stat(root + '/failed'),
          Deno.errors.NotFound,
        );
        Db.prototype.prepareReadSnapshot = prepare;
        const server = await store.server();
        await server.exec('CREATE TABLE traffic(body TEXT)');
        await server.execute('INSERT INTO traffic VALUES(?)', [
          'x'.repeat(70000),
        ]);
        await store.removeRoom(id);
        const cut = await store.snapshot(root + '/after');
        assertEquals(cut.files.length, 1);
        assertEquals(store.stats().server.active, 0);
        assertEquals(store.stats().server.closed, false);
      } finally {
        Db.prototype.prepareReadSnapshot = prepare;
        await store.close();
        await Deno.remove(root, { recursive: true });
      }
    });
  }
});

for (const phase of ['pin', 'export', 'release']) {
  Deno.test(`store snapshot: ${phase} failure preserves the primary cause through cleanup`, async () => {
    const { root, store } = await fixture();
    await store.room('!cleanup:test', { create: true });
    const prepare = Db.prototype.prepareReadSnapshot;
    const primary = new Error('original ' + phase + ' failure');
    const cleanup = new Error('independent source release failure');
    Db.prototype.prepareReadSnapshot = async function () {
      const prepared = await prepare.call(this);
      if (!this.path.includes('/rooms/')) return prepared;
      return {
        pin: async () => {
          if (phase === 'pin') throw primary;
          const reader = await prepared.pin();
          return {
            ...reader,
            export: phase === 'export'
              ? () => Promise.reject(primary)
              : (path) => reader.export(path),
          };
        },
        release: async () => {
          await prepared.release();
          throw cleanup;
        },
      };
    };
    const causes = (error: unknown): unknown[] => [
      error,
      ...(error instanceof AggregateError ? error.errors.flatMap(causes) : []),
      ...(error instanceof Error && error.cause ? causes(error.cause) : []),
    ];
    try {
      const error = await assertRejects(() => store.snapshot(root + '/failed'));
      assert(causes(error).includes(cleanup));
      if (phase !== 'release') assert(causes(error).includes(primary));
      await assertRejects(
        () => Deno.stat(root + '/failed'),
        Deno.errors.NotFound,
      );
      assertEquals(
        (await Array.fromAsync(Deno.readDir(root + '/live')))
          .filter((entry) => entry.name.startsWith('.backup-')),
        [],
      );
      Db.prototype.prepareReadSnapshot = prepare;
      await store.snapshot(root + '/after');
    } finally {
      Db.prototype.prepareReadSnapshot = prepare;
      await store.close();
      await Deno.remove(root, { recursive: true });
    }
  });
}
