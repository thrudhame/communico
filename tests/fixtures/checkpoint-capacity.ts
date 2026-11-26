import { Capacity } from '#engine/store/capacity.ts';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import { databaseFiles } from '#engine/store/layout.ts';
import { assert, assertEquals } from '@std/assert';
import { stat } from 'node:fs/promises';

const [directory, kind] = Deno.args;
const files = databaseFiles(directory);
const ffi = new Turso('./.native/libturso_ffi.so');
const budget = 11 * 1024 * 1024;
const capacity = new Capacity([directory], budget);
const threshold = 64 * 1024;
const updates = Array.from({ length: 1024 }, (_, i) => ({ id: i * 128 }));
const updated = "SELECT id FROM t WHERE substr(payload,1,1)='b' ORDER BY id";
const disk = async () => (await capacity.status()).filesystems[0];
const blocks = async (path: string) => (await stat(path)).blocks * 512;
let db: Db | undefined;
try {
  db = await Db.open(ffi, files.database, threshold, undefined, capacity);
  await db.exec(
    'CREATE TABLE t (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)',
  );
  await db.tx(async (conn) => {
    for (let i = 0; i < 1024 * 128; i += 512) {
      const values = Array.from(
        { length: 512 },
        (_, j) => `(${i + j}, 'a${String(i + j).padStart(64, '0')}')`,
      );
      await conn.exec('INSERT INTO t VALUES ' + values.join(','));
    }
  }, { mode: 'immediate' });
  assert((await disk()).usedBytes < budget);
  assertEquals(await blocks(files.wal), 0);
  assertEquals(db.gate.stats().completed, 1);

  const arm = Deno.env.get('CHECKPOINT_FAULT_ARM');
  if (arm) await Deno.writeTextFile(arm, '');
  let attempts = 0;
  db.gate.addEventListener('checkpoint', () => attempts++);
  const changed = await db.execute(
    "UPDATE t SET payload = 'b' || substr(payload,2) WHERE id % 128 = 0",
  );
  assertEquals(changed, updates.length);
  assertEquals(attempts, 1);
  const after = await disk();
  assertEquals(after.checkpoint.active, false);
  if (kind === 'peak') {
    assert(
      after.checkpoint.peakOvershootBytes > 0,
      'peak vanished after truncate',
    );
  } else {
    const retained = await blocks(files.wal);
    assert(retained > 0, 'native failure must retain allocated WAL blocks');
    if (kind === 'main') assert(retained >= 4 * 1024 * 1024);
    assertEquals(after.checkpoint.retainedWalBytes, retained);
    assertEquals(after.filesystemFull, true);
    assert(after.protectedBytes >= retained + await blocks(files.database));
    assertEquals(after.usedBytes, after.protectedBytes);
    assertEquals(db.gate.stats().completed, 1);
    await Deno.remove(arm!);
    // An ordinary commit triggers the existing threshold schedule; do not
    // call the checkpoint binding directly to make recovery pass.
    assertEquals(await db.query(updated), updates);
    assertEquals(attempts, 2);
  }
  const released = await disk();
  assertEquals(db.gate.stats().completed, 2);
  assertEquals(released.checkpoint.overshootBytes, 0);
  assertEquals(released.checkpoint.retainedWalBytes, 0);
  assertEquals(released.filesystemFull, false);
  assert(released.usedBytes < budget);
  assertEquals(await blocks(files.wal), 0);
  assertEquals(await blocks(files.log), 0);
  await db.close();
  db = undefined;
  db = await Db.open(ffi, files.database, threshold, undefined, capacity);
  assertEquals(await db.query(updated), updates);
} finally {
  await db?.close();
  ffi.close();
}
