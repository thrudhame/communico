import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { closeApp, openApp } from '#engine/app.ts';
import { createBackup } from '#engine/backup/bundle.ts';
import { restoreBackup } from '#engine/backup/restore.ts';
import { createRoom } from '#engine/client/write.ts';
import { loadedConfig, setConfigForTests } from '#engine/config.ts';
import { receiptRows, setReceipt } from '#engine/server/ephemeral.ts';
import { registerUser } from '#engine/tenant/users.ts';

Deno.test('backup receipt graph: ordinary projected room and read survive backup, restore and cold recovery', async () => {
  const root = await Deno.makeTempDir({ prefix: 'backup-receipt-graph-' });
  const settings = loadedConfig();
  const cfg = {
    ...structuredClone(settings.config),
    store: { ...settings.config.store, dir: join(root, 'source') },
    media: { ...settings.config.media, root: join(root, 'media') },
    federation: { ...settings.config.federation, enabled: false },
  };
  await Deno.mkdir(cfg.media.root);
  setConfigForTests(cfg);
  try {
    const app = await openApp(cfg.store);
    const user = await registerUser(app.tenant, {
      localpart: 'audit',
      password: 'pw',
    });
    const { roomId } = await createRoom({ creator: user.user_id });
    const [member] = await app.server.query(
      'SELECT event FROM memberships WHERE room=? AND user=?',
      [roomId, user.user_id],
    );
    assert(
      await setReceipt(
        app.server,
        roomId,
        user.user_id,
        'm.read',
        String(member.event),
      ),
    );
    const tables = [
      'receipt_dag_nodes',
      'receipt_dag_edges',
      'receipt_membership_events',
    ];
    const before = await Promise.all(
      tables.map((table) =>
        app.server.query(`SELECT * FROM ${table} ORDER BY room,event`)
      ),
    );
    assert(before.every((rows) => rows.length > 0));
    const receipts = await receiptRows(app.server, roomId, 0, user.user_id);
    const watermark = await app.server.query(
      'SELECT position FROM watermarks WHERE source=?',
      ['receipt-graph:' + roomId],
    );
    assert(Number(watermark[0].position) > 0);
    const bundle = join(root, 'bundle');
    await createBackup(app.store, bundle, {
      ...settings,
      config: cfg,
      configPath: null,
    });
    await closeApp();
    const target = {
      ...settings,
      configPath: null,
      config: {
        ...cfg,
        store: { ...cfg.store, dir: join(root, 'restored') },
        media: { ...cfg.media, root: join(root, 'restored-media') },
      },
    };
    await restoreBackup(bundle, {}, target);
    setConfigForTests(target.config);
    const restored = await openApp(target.config.store);
    assertEquals(
      await Promise.all(
        tables.map((table) =>
          restored.server.query(`SELECT * FROM ${table} ORDER BY room,event`)
        ),
      ),
      before,
    );
    assertEquals(
      await receiptRows(restored.server, roomId, 0, user.user_id),
      receipts,
    );
    assertEquals(
      await restored.server.query(
        'SELECT position FROM watermarks WHERE source=?',
        ['receipt-graph:' + roomId],
      ),
      watermark,
    );
  } finally {
    await closeApp();
    setConfigForTests({});
    await Deno.remove(root, { recursive: true });
  }
});
