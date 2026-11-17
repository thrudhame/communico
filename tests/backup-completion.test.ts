import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { openStore } from '#engine/store/index.ts';
import { roomSchema } from '#engine/room/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { registerRoom } from '#engine/server/registry.ts';
import { projectThrough } from '#engine/server/project.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { genesis } from '#tests/fixtures/genesis.ts';
import { auditSnapshot } from '#engine/backup/audit.ts';
import { inspectSnapshot } from '#engine/store/inspect.ts';
import { inventoryRestoredWork } from '#engine/backup/work.ts';

Deno.test('backup completion: audit and restored-work inventory retain identity, exact receipts and both progress phases', async (t) => {
  const root = await Deno.makeTempDir({ prefix: 'backup-completion-' });
  const config = {
    dir: join(root, 'live'),
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 16,
    idleseconds: 300,
  };
  const schemas = {
    room: roomSchema,
    tenant: tenantSchema,
    server: serverSchema,
  };
  const store = await openStore(config, { schemas });
  try {
    await openTenant(store, 'test', { create: true });
    const g = await genesis(store, { roomId: '!backup-completion:test' });
    await registerRoom(store, g.roomId);
    const write = (body: string) =>
      sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: { msgtype: 'm.text', body },
      }, g.signer);
    const published = (await write('published')).completion!;
    await projectThrough(store, published);
    const pending = (await write('pending')).completion!;
    const room = await store.room(g.roomId);
    let serial = 0;
    const audit = async () => {
      const dest = join(root, 'snapshot-' + ++serial);
      const cut = await store.snapshot(dest);
      return await auditSnapshot(config, dest, cut.files, 'test', root);
    };
    await t.step(
      'valid publication lag and callback lag remain recoverable',
      async () => {
        await audit();
        await room.execute('UPDATE completion_state SET completed_through=0');
        await audit();
        const dest = join(root, 'inventory');
        const cut = await store.snapshot(dest);
        const work = await inspectSnapshot(
          config,
          dest,
          cut.files,
          root,
          schemas,
          (snapshot) => inventoryRestoredWork(snapshot, Date.now()),
        );
        const held = work.rooms.find((r) => r.id === g.roomId)!;
        assertEquals(held.completion.generation, pending.generation);
        assertEquals(held.completion.completedThrough, 0);
        assertEquals(held.completion.publishedThrough, published.through);
        assertEquals(held.completion.callbackPending, true);
        assert(
          held.completion.receipts.some((r) =>
            r.event === pending.eventId && r.through === pending.through &&
            r.basis === 'accepted'
          ),
        );
      },
    );
    const state = (await room.query('SELECT * FROM completion_state'))[0];
    for (
      const [name, corrupt, repair] of [
        [
          'missing identity',
          'DELETE FROM completion_state',
          'INSERT INTO completion_state VALUES(1,?,?,?)',
        ],
        [
          'empty generation',
          "UPDATE completion_state SET generation=''",
          'UPDATE completion_state SET generation=?',
        ],
        [
          'baseline past source',
          'UPDATE completion_state SET legacy_through=999999',
          'UPDATE completion_state SET legacy_through=?',
        ],
        [
          'progress past source',
          'UPDATE completion_state SET completed_through=999999',
          'UPDATE completion_state SET completed_through=?',
        ],
        [
          'progress past publication',
          'UPDATE completion_state SET completed_through=' + pending.through,
          'UPDATE completion_state SET completed_through=?',
        ],
      ]
    ) {
      await t.step(name, async () => {
        await room.execute(corrupt);
        await assertRejects(audit, Error, 'completion');
        await room.execute(
          repair,
          name === 'missing identity'
            ? [state.generation, state.legacy_through, state.completed_through]
            : [
              name === 'empty generation'
                ? state.generation
                : name === 'baseline past source'
                ? state.legacy_through
                : state.completed_through,
            ],
        );
      });
    }
    for (
      const [name, corrupt, repair] of [
        [
          'missing receipt event',
          "UPDATE completion_receipts SET event='$absent' WHERE event=?",
          "UPDATE completion_receipts SET event=? WHERE event='$absent'",
        ],
        [
          'receipt past source',
          'UPDATE completion_receipts SET through=999999 WHERE event=?',
          'UPDATE completion_receipts SET through=? WHERE event=?',
        ],
        [
          'fractional receipt cut',
          'UPDATE completion_receipts SET through=through-0.5 WHERE event=?',
          'UPDATE completion_receipts SET through=? WHERE event=?',
        ],
        [
          'invalid receipt basis',
          "UPDATE completion_receipts SET basis='guessed' WHERE event=?",
          "UPDATE completion_receipts SET basis='accepted' WHERE event=?",
        ],
      ]
    ) {
      await t.step(name, async () => {
        await room.execute(corrupt, [pending.eventId]);
        await assertRejects(audit, Error, 'completion');
        await room.execute(
          repair,
          name === 'receipt past source' || name === 'fractional receipt cut'
            ? [pending.through, pending.eventId]
            : [pending.eventId],
        );
      });
    }
    await audit();
  } finally {
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});
