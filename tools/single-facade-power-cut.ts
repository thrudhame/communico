// Workload and cold verifier for single-facade-power-cut.sh. Not a test seam:
// use the facade's real capacity owner, journal, and upload publication path.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import { Journal } from '#engine/facade/journal.ts';
import { uploadMedia } from '#engine/media.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { Capacity } from '#engine/store/capacity.ts';
import { type Database } from '#engine/store/db.ts';
import { openStore } from '#engine/store/index.ts';
import { StoragePressureError } from '#engine/store/pressure.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { createMedia, getMedia } from '#engine/tenant/media.ts';

const [mode, root, ledger, arg, end] = Deno.args;
const stream = { source: 'home', incarnation: 'home-1', stream: 'control' };
const caps = [{ type: 'control', version: 1 }];
const serverName = 'power-cut.test';
const user = 'fixture';
const rounds = 4;
const body = (id: number) => new Uint8Array(32768).fill(id);
const mediaId = (id: number) => `receipt_${id}`;
const media = `${root}/media`;
const dir = `${root}/store`;
const control = `${root}/control`;
const large = 4 * 1024 * 1024;
const names = ['db', 'out', 'in', 'apply', 'file'] as const;
type Step = typeof names[number];
type Ack = { step: Step | 'control'; id: number; hash?: string };

function syncWrite(path: string, data: Uint8Array, append = false) {
  using file = Deno.openSync(path, { create: true, write: true, append });
  while (data.length) data = data.subarray(file.writeSync(data));
  file.syncSync();
}

async function ack(receipt: Ack) {
  syncWrite(
    ledger,
    new TextEncoder().encode(JSON.stringify(receipt) + '\n'),
    true,
  );
  const mark = `ack-${receipt.step}-${receipt.id}`;
  const status = await new Deno.Command('sudo', {
    args: ['-n', 'dmsetup', 'message', arg, '0', 'mark', mark],
  }).spawn().status;
  assert(status.success, mark);
}

async function integrity(db: Database) {
  assertEquals(Object.values((await db.query('PRAGMA integrity_check'))[0]), [
    'ok',
  ]);
}

async function fileBytes(path: string) {
  try {
    return await Deno.readFile(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return null;
    throw cause;
  }
}

async function run() {
  const capacity = new Capacity([root], null);
  setConfigForTests({
    media: { ...config().media, root: media, maxbytes: large },
  });
  Deno.env.set('TURSO_TMPDIR', `${root}/scratch`);
  if (mode === 'init') {
    for (const path of [media, dir, `${root}/scratch`]) await Deno.mkdir(path);
    syncWrite(control, Uint8Array.of(0));
  }
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, {
    schemas: { server: serverSchema, tenant: tenantSchema },
    capacityOwner: capacity,
  });
  try {
    const server = await store.server();
    const tenant = await openTenant(store, serverName, {
      create: mode === 'init',
    });
    const tenantDb = await store.tenant(serverName);
    const journal = new Journal(server, caps);
    const upload = (id: number, size = body(id).length) =>
      uploadMedia(
        tenant,
        user,
        new Blob([new Uint8Array(size).fill(id)]).stream(),
        {
          content_type: 'application/octet-stream',
        },
        { reservation: mediaId(id), capacity, maxBytes: size },
      );
    if (mode === 'init') {
      await server.exec(
        'CREATE TABLE cut_receipts(id INTEGER PRIMARY KEY, value INTEGER NOT NULL)',
      );
      await tenantDb.execute('INSERT INTO users(localpart) VALUES (?)', [user]);
      for (let id = 1; id <= rounds; id++) {
        await createMedia(tenant, user, mediaId(id), 'pending');
      }
    } else if (mode === 'record') {
      const first = Number(end);
      assert(first === 1 || first === 3);
      if (first === 1) {
        // Overwrite a seed block and sync it; the seed is the control cut
        // with this known barrier (and its write) omitted.
        syncWrite(control, Uint8Array.of(1));
        await ack({ step: 'control', id: 0 });
      }
      for (let id = first; id < first + 2; id++) {
        await server.execute('INSERT INTO cut_receipts VALUES (?,?)', [
          id,
          id * 17,
        ]);
        await ack({ step: 'db', id });
        const record = await journal.append('edge', {
          ...stream,
          type: 'control',
          version: 1,
          operationId: `op-${id}`,
          payload: { id },
        });
        assertEquals(record.sequence, id);
        await ack({ step: 'out', id, hash: record.hash });
        const heads = await journal.receive('home', [record]);
        assertEquals(heads?.received.sequence, id);
        await ack({ step: 'in', id, hash: record.hash });
        const applied = await journal.complete('home', stream, record, {
          accepted: id,
        });
        assertEquals(applied.applied.sequence, id);
        await ack({ step: 'apply', id, hash: record.hash });
        assertEquals(await journal.receive('home', [record]), applied);
        const uploaded = await upload(id);
        assertEquals(uploaded, {
          mediaId: mediaId(id),
          sizeBytes: body(id).length,
        });
        await ack({ step: 'file', id });
      }
    } else if (mode === 'pressure') {
      const status = await store.capacityStatus();
      assert(status);
      const [disk] = status.filesystems;
      assertEquals(disk.budgetBytes, null);
      assertEquals(disk.quotaBackstop, true);
      assert((arg === 'quota') === (disk.freeBytes > large));
      await assertRejects(() => upload(3, large), StoragePressureError);
      assertEquals((await getMedia(tenant, mediaId(3)))?.state, 'pending');
      assertEquals(await fileBytes(`${media}/${mediaId(3)}`), null);
      console.log(
        `pressure=${arg} free=${disk.freeBytes} quota=${disk.quotaBackstop} retryable=true`,
      );
    } else if (mode === 'verify') {
      const receipts: Ack[] = (await Deno.readTextFile(ledger)).trim().split(
        '\n',
      )
        .filter(Boolean).slice(0, Number(arg)).map((line) => JSON.parse(line));
      assertEquals(receipts.length, Number(arg));
      if (receipts.some((item) => item.step === 'control')) {
        assertEquals(
          await fileBytes(control),
          Uint8Array.of(1),
          'ACK_LOST control',
        );
      }
      const count = (step: Step) =>
        receipts.filter((receipt) => receipt.step === step).length;
      await integrity(server);
      await integrity(tenantDb);
      const rows = await server.query(
        'SELECT id,value FROM cut_receipts ORDER BY id',
      );
      assert(
        rows.length >= count('db') && rows.length <= rounds,
        'ACK_LOST db',
      );
      assertEquals(
        rows,
        rows.map((_, i) => ({ id: i + 1, value: (i + 1) * 17 })),
      );
      const limits = { maxItems: rounds + 1, maxBytes: 1024 * 1024 };
      const outgoing = await journal.page('edge', 'out', stream, 0, limits);
      const incoming = await journal.page('home', 'in', stream, 0, limits);
      for (
        const [step, page] of [['out', outgoing], ['in', incoming]] as const
      ) {
        assert(
          page.records.length >= count(step) &&
            page.records.length <= rows.length,
          `ACK_LOST ${step}`,
        );
        assertEquals(page.head.sequence, page.records.length);
        for (const [i, record] of page.records.entries()) {
          assertEquals(record.sequence, i + 1);
          assertEquals(record.operationId, `op-${i + 1}`);
          assertEquals(record.payload, { id: i + 1 });
          assertEquals(
            record.previous,
            i === 0 ? '' : page.records[i - 1].hash,
          );
          const receipt = receipts.find((item) =>
            item.step === step && item.id === i + 1
          );
          if (receipt) assertEquals(record.hash, receipt.hash);
        }
      }
      assertEquals(
        incoming.records,
        outgoing.records.slice(0, incoming.records.length),
      );
      const head = await journal.heads('home', 'in', stream);
      assert(
        head.applied.sequence >= count('apply') &&
          head.applied.sequence <= head.received.sequence,
        'ACK_LOST apply',
      );
      assertEquals(
        head.applied.hash,
        incoming.records[head.applied.sequence - 1]?.hash ?? '',
      );
      const published = new Set<string>();
      for (let id = 1; id <= rounds; id++) {
        const file = mediaId(id);
        const row = await getMedia(tenant, file);
        assert(row);
        const bytes = await fileBytes(`${media}/${file}`);
        if (bytes) {
          assertEquals(bytes, body(id), `partial file ${file}`);
          published.add(file);
        }
        if (id <= count('file')) {
          assertEquals(row.state, 'uploaded', `ACK_LOST ${file}`);
        }
        if (row.state === 'uploaded') {
          assertEquals(row.size_bytes, body(id).length);
          assert(bytes, `published metadata without file ${file}`);
        }
      }
      for await (const entry of Deno.readDir(media)) {
        assert(
          entry.isFile &&
            (published.has(entry.name) || entry.name.endsWith('.part')),
          `unexpected media ${entry.name}`,
        );
      }
    } else {
      throw new Error(`unknown fixture mode ${mode}`);
    }
  } finally {
    await store.close();
  }
}

await run();
