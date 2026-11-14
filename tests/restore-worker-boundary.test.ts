import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { closeApp, openApp } from '#engine/app.ts';
import { loadConfig, loadedConfig, setConfigForTests } from '#engine/config.ts';
import { DelayedEvents } from '#engine/delayed-events.ts';
import { createRoom, sendEvent } from '#engine/client/write.ts';
import { join as joinRoom } from '#engine/client/membership.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { setPusher } from '#engine/tenant/pushers.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { startPushSender } from '#engine/push/sender.ts';
import { copyPrivate } from '#engine/store/files.ts';
import { withCandidateStore } from '#engine/store/candidate.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { beginRecovery } from '#engine/server/recovery.ts';
import { createBackup } from '#engine/backup/bundle.ts';
import { restoreBackup } from '#engine/backup/restore.ts';
import { readManifest } from '#engine/backup/manifest.ts';
import { inventoryRestoredWork } from '#engine/backup/work.ts';

type Json = Record<string, unknown>;

Deno.test('restored work: failed/incomplete report holds overdue commands and real gateway pushes; a durable report resumes retained jobs and discloses lost B effects', async () => {
  const root = await Deno.makeTempDir({ prefix: 'restore-worker-boundary-' });
  let phase = 'source';
  let reportPath = '', reportText = '';
  const requests: { phase: string; body: Json; reportVerified: boolean }[] = [];
  const gateway = Deno.serve({
    hostname: '127.0.0.1',
    port: 0,
    cert: await Deno.readTextFile('tests/fixtures/tls/localhost.crt'),
    key: await Deno.readTextFile('tests/fixtures/tls/localhost.key'),
    onListen() {},
  }, async (request) => {
    let reportVerified = false;
    if (phase === 'restored') {
      reportVerified = await Deno.readTextFile(reportPath) === reportText;
    }
    requests.push({ phase, body: await request.json(), reportVerified });
    return Response.json({ rejected: [] });
  });
  const settings = loadedConfig();
  const cfg = {
    ...structuredClone(settings.config),
    store: {
      ...settings.config.store,
      dir: join(root, 'source'),
      library: './.native/libturso_ffi.so',
    },
    media: { ...settings.config.media, root: join(root, 'media') },
    federation: { ...settings.config.federation, enabled: false },
    delayedevents: { ...settings.config.delayedevents, maxdelayms: 60000 },
    push: {
      ...settings.config.push,
      allowlist: ['127.0.0.0/8'],
      cacerts: ['tests/fixtures/tls/ca.crt'],
    },
  };
  setConfigForTests(cfg);
  const schemas = {
    room: roomSchema,
    tenant: tenantSchema,
    server: serverSchema,
  };
  let preparedWorker: DelayedEvents | undefined;
  let sourcePush: Awaited<ReturnType<typeof startPushSender>> | undefined;
  try {
    const app = await openApp(cfg.store);
    await app.delayedEvents.stop();
    await app.pushSender.stop();
    const alice = await registerUser(app.tenant, {
      localpart: 'work-alice',
      password: 'pw',
    });
    const bob = await registerUser(app.tenant, {
      localpart: 'work-bob',
      password: 'pw',
    });
    const room = (await createRoom({
      creator: alice.user_id,
      preset: 'public_chat',
    })).roomId;
    await joinRoom(room, bob.user_id);
    await setPusher(app.tenant, 'work-bob', bob.access_token!, {
      app_id: 'restore-proof',
      pushkey: 'retained-target',
      kind: 'http',
      app_display_name: 'Restore proof',
      device_display_name: 'Retained device',
      lang: 'en',
      data: {
        url: 'https://127.0.0.1:' + gateway.addr.port +
          '/_matrix/push/v1/notify',
      },
    });
    await projectTenant(app.store, app.tenant.serverName);
    const pendingPush = await sendEvent(
      room,
      alice.user_id,
      'm.room.message',
      { msgtype: 'm.text', body: 'push pending at A' },
      null,
      'pending-push',
    );
    const schedule = (body: string) => ({
      roomId: room,
      userId: alice.user_id,
      stateKey: null,
      type: 'm.room.message',
      content: { msgtype: 'm.text', body },
      delay: 60000,
      deviceId: null,
    });
    const overdue = await app.delayedEvents.schedule(
      schedule('cancelled after A but restored overdue'),
    );
    // The existing delayed submission seam models a crash after room commit.
    preparedWorker = new DelayedEvents({
      store: app.store,
      tenant: {
        ...app.tenant,
        tx: (fn) =>
          app.tenant.tx((tx) =>
            fn({
              ...tx,
              delayedEvents: {
                ...tx.delayedEvents,
                finish: () => Promise.reject(new Error('after-room-commit')),
              },
            })
          ),
      },
    });
    const prepared = await preparedWorker.schedule(
      schedule('exact prepared A'),
    );
    await assertRejects(
      () => preparedWorker!.action(prepared.delay_id, 'send'),
      Error,
      'after-room-commit',
    );
    await preparedWorker.stop();
    const submission = await app.tenant.tx((tx) =>
      tx.delayedEvents.submission(prepared.delay_id)
    );
    assert(submission?.pdu);
    const preparedEvent = String(submission.eventId);
    await app.tenant.tx(async (tx) => {
      await tx.delayedEvents.action(overdue.delay_id, 'send', Date.now() - 1);
      await tx.delayedEvents.retry([prepared.delay_id], Date.now() - 1);
    });
    const bundle = join(root, 'archive-A');
    await createBackup(app.store, bundle, {
      ...settings,
      config: cfg,
      configPath: null,
    });
    const manifest = await readManifest(bundle);
    const files = manifest.databases.map((file) => ({
      kind: file.kind,
      id: file.id,
      path: file.path.slice('store/'.length),
    }));

    // B really cancels A's command and acknowledges A's gateway jobs.
    await app.delayedEvents.action(overdue.delay_id, 'cancel');
    preparedWorker = new DelayedEvents(app);
    await preparedWorker.drain();
    await preparedWorker.stop();
    sourcePush = await startPushSender({
      store: app.store,
      tenant: app.tenant,
      automatic: false,
    });
    while (
      (await app.server.query(
        "SELECT 1 FROM push_delivery WHERE state='pending'",
      ))
        .length
    ) await sourcePush.tick();
    await sourcePush.stop();
    const acknowledgedAtB = requests.map((r) =>
      String((r.body.notification as Json).event_id)
    );
    assert(acknowledgedAtB.includes(pendingPush.event_id));
    assert(acknowledgedAtB.includes(preparedEvent));
    assertEquals(
      await app.tenant.tx((tx) => tx.delayedEvents.get(overdue.delay_id)),
      null,
    );
    await closeApp();
    const sourceRequests = requests.length;
    const candidateRoot = join(root, 'candidate');
    await copyPrivate(join(bundle, 'store'), candidateRoot);
    const failed = { ...cfg.store, dir: candidateRoot };
    phase = 'incomplete-report';
    await assertRejects(
      () =>
        withCandidateStore(
          failed,
          candidateRoot,
          files,
          schemas,
          async (candidate) => {
            const server = candidate.files.find((file) =>
              file.kind === 'server'
            )!;
            await candidate.tx(server, beginRecovery);
            throw new Error('candidate failure before report');
          },
        ),
      Error,
      'candidate failure before report',
    );
    await assertRejects(() => openApp(failed), Error, 'incomplete');
    assertEquals(requests.length, sourceRequests);
    await withCandidateStore(
      failed,
      candidateRoot,
      files,
      schemas,
      async (candidate) => {
        const roomFile = candidate.files.find((file) => file.id === room)!;
        assertEquals(
          await candidate.read(roomFile, (db) =>
            db.query(
              "SELECT id FROM events WHERE json_extract(pdu,'$.content.body')=?",
              [
                'cancelled after A but restored overdue',
              ],
            )),
          [],
          'failed startup cannot run an overdue delayed command',
        );
      },
    );
    // The successful path is the whole production restore, not a hand-written
    // report or a scheduler invoked directly against archived files.
    const result = await restoreBackup(bundle, {}, {
      ...settings,
      configPath: null,
      config: {
        ...cfg,
        store: { ...cfg.store, dir: join(root, 'restored') },
        media: { ...cfg.media, root: join(root, 'restored-media') },
      },
    });
    const portable = loadConfig({
      defaultsPath: settings.defaultsPath,
      configPath: result.configPath,
      env: {},
    });
    setConfigForTests(portable.config);
    const restored = portable.config.store;
    const pending = result.report.pendingWork as Awaited<
      ReturnType<typeof inventoryRestoredWork>
    >;
    const delayed = pending.tenants.find((t) => t.id === app.tenant.serverName)!
      .delayed;
    assertEquals(delayed.length, 2);
    assertEquals(
      delayed.find((row) => row.id === overdue.delay_id)?.overdue,
      1,
    );
    assertEquals(
      delayed.find((row) => row.id === prepared.delay_id)?.prepared,
      1,
    );
    assert(
      pending.push.deliveries.some((row) => row.event === pendingPush.event_id),
    );
    // The injected finish failure precedes afterRoomCommit/projection. Its
    // future push is still room-owned work, not yet a server queue row at A.
    assert(
      pending.rooms.some((entry) =>
        entry.id === room && Number(entry.unprojectedChanges) > 0
      ),
    );
    reportPath = result.reportPath;
    reportText = await Deno.readTextFile(reportPath);
    assert(reportText.includes('cancellations'));
    assert(reportText.includes('already observed effects can repeat'));
    assertEquals((await Deno.stat(reportPath)).mode! & 0o777, 0o600);
    assertEquals(requests.length, sourceRequests);
    await Deno.rename(reportPath, reportPath + '.held');
    await assertRejects(() => openApp(restored), Deno.errors.NotFound);
    assertEquals(requests.length, sourceRequests);
    await Deno.rename(reportPath + '.held', reportPath);
    await Deno.writeTextFile(reportPath, reportText + ' ');
    await assertRejects(() => openApp(restored), Error, 'digest mismatch');
    assertEquals(requests.length, sourceRequests);
    await Deno.writeTextFile(reportPath, reportText);

    phase = 'restored';
    const running = await openApp(restored);
    await running.delayedEvents.drain();
    while (
      (await running.server.query(
        "SELECT 1 FROM push_delivery WHERE state='pending'",
      ))
        .length
    ) await running.pushSender.tick();
    const restoredRequests = requests.slice(sourceRequests);
    assert(restoredRequests.length > 0);
    assert(
      restoredRequests.every((r) => r.phase === 'restored' && r.reportVerified),
    );
    const replayed = restoredRequests.map((r) =>
      String((r.body.notification as Json).event_id)
    );
    assert(
      replayed.includes(pendingPush.event_id),
      'lost B acknowledgment permits ordinary at-least-once push',
    );
    assert(replayed.includes(preparedEvent));
    const roomDb = await running.store.room(room);
    assertEquals(
      (await roomDb.query('SELECT id FROM events WHERE id=?', [preparedEvent]))
        .length,
      1,
      'prepared room commit is reconciled, never authored twice',
    );
    assertEquals(
      (await roomDb.query(
        "SELECT id FROM events WHERE json_extract(pdu,'$.content.body')=?",
        [
          'cancelled after A but restored overdue',
        ],
      )).length,
      1,
      'lost B cancellation is disclosed and the retained A command executes',
    );
    assertEquals(
      await running.tenant.tx((tx) => tx.delayedEvents.list('work-alice')),
      [],
    );
    assertEquals(await Deno.readTextFile(reportPath), reportText);
  } finally {
    await preparedWorker?.stop();
    await sourcePush?.stop();
    await closeApp();
    await gateway.shutdown();
    setConfigForTests({});
    await Deno.remove(root, { recursive: true });
  }
});
