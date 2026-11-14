import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { httpSuite } from '#tests/http-app.ts';
import { closeApp, openApp, theApp } from '#engine/app.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { join as joinRoom } from '#engine/room/membership.ts';
import { putAccountData } from '#engine/tenant/accountdata.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { insertMessage } from '#engine/tenant/todevice.ts';
import { beginRecovery, recoveryState } from '#engine/server/recovery.ts';
import {
  boundFutureToken,
  encodeStreamToken,
  parseStreamToken,
} from '#engine/client/tokens.ts';
import { openStore } from '#engine/store/index.ts';
import { withCandidateStore } from '#engine/store/candidate.ts';
import { copyPrivate } from '#engine/store/files.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';
import { writeRestoreReport } from '#engine/backup/report.ts';

const suite = httpSuite('HTTP restore recovery epoch');
type Json = Record<string, unknown>;
type SyncBody = {
  next_batch: string;
  rooms: { join: Record<string, { state: { events: Json[] } }> };
  account_data: { events: { type: string }[] };
  to_device: { events: Json[] };
  device_lists: { changed: string[]; left: string[] };
};

suite.test('an older delivery epoch resets every sync baseline, survives numeric aliasing and cannot acknowledge old inbox proofs', async () => {
  const app = theApp();
  const alice = await suite.registerTestUser('recover-alice', 'pw');
  const bob = await suite.registerTestUser('recover-bob', 'pw');
  const room = await createRoom(app.store, {
    creator: alice.user_id,
    preset: 'public_chat',
  }, app.tenant.signer());
  await joinRoom(
    await openRoom(app.store, room.roomId),
    bob.user_id,
    app.tenant.signer(),
  );
  await putAccountData(app.tenant, 'recover-alice', '', 'recovery.test', {
    retained: true,
  });
  const d = await deviceIdentity(app.tenant, 'recover-alice', alice.device_id!);
  await (await app.store.tenant(app.tenant.serverName)).tx((conn) =>
    insertMessage(conn, d, 'pending', {
      type: 'm.room_key',
      content: { retained: true },
    }, config().e2ee)
  );
  async function sync(since?: string) {
    const response = await suite.matrix(
      new Request(
        'http://x/_matrix/client/v3/sync?timeout=0' +
          (since ? '&since=' + encodeURIComponent(since) : ''),
        { headers: { Authorization: 'Bearer ' + alice.access_token } },
      ),
    );
    assertEquals(response.status, 200, await response.clone().text());
    return await response.json() as SyncBody;
  }
  const initial = await sync();
  const state = await app.server.tx(beginRecovery);
  const reset = await sync(String(initial.next_batch));
  const token = parseStreamToken(String(reset.next_batch))!;
  assertEquals((token as unknown as { epoch: string }).epoch, state.epoch);
  assert(reset.rooms.join[room.roomId].state.events.length > 0);
  assert(
    reset.account_data.events.some((e: Json) => e.type === 'recovery.test'),
  );
  assertEquals(reset.to_device.events.length, 1);
  assert(reset.device_lists.changed.includes(bob.user_id));
  const changed = await suite.matrix(
    new Request(
      'http://x/_matrix/client/v3/keys/changes?from=' +
        encodeURIComponent(initial.next_batch) + '&to=' +
        encodeURIComponent(reset.next_batch),
      { headers: { Authorization: 'Bearer ' + alice.access_token } },
    ),
  );
  assertEquals(changed.status, 200, await changed.clone().text());
  assert(
    ((await changed.json()) as { changed: string[] }).changed.includes(
      bob.user_id,
    ),
  );
  // The same wire token remains a pagination cursor, not a full-sync request.
  const page = await suite.matrix(
    new Request(
      'http://x/_matrix/client/v3/rooms/' + encodeURIComponent(room.roomId) +
        '/messages?dir=b&limit=0&from=' + encodeURIComponent(reset.next_batch),
      { headers: { Authorization: 'Bearer ' + alice.access_token } },
    ),
  );
  assertEquals(page.status, 200, await page.clone().text());
  assertEquals(((await page.json()) as { chunk: unknown[] }).chunk, []);
  const alias = String(reset.next_batch).replace(
    '_z' + state.epoch,
    '_z' + 'f'.repeat(32),
  );
  const again = await sync(alias);
  assert(again.rooms.join[room.roomId].state.events.length > 0);
  assertEquals(again.to_device.events.length, 1);
  assertEquals(
    encodeStreamToken(parseStreamToken(String(again.next_batch))!),
    again.next_batch,
  );
  const incremental = await sync(String(again.next_batch));
  assertEquals(incremental.to_device.events, []);
  assertEquals(incremental.rooms.join[room.roomId], undefined);
});

suite.test('matching-era future stream numbers are bounded before polling without turning a forged cut into inbox deletion authority', async () => {
  const app = theApp();
  const alice = await suite.registerTestUser('future-alice', 'pw');
  const bob = await suite.registerTestUser('future-bob', 'pw');
  await app.server.tx(beginRecovery);
  const room = await createRoom(app.store, {
    creator: alice.user_id,
    preset: 'public_chat',
  }, app.tenant.signer());
  await joinRoom(
    await openRoom(app.store, room.roomId),
    bob.user_id,
    app.tenant.signer(),
  );
  const device = await deviceIdentity(
    app.tenant,
    'future-alice',
    alice.device_id!,
  );
  await (await app.store.tenant(app.tenant.serverName)).tx((tx) =>
    insertMessage(tx, device, 'retained', {
      type: 'm.room_key',
      content: { retained: true },
    }, config().e2ee)
  );
  const sync = async (since?: string, timeout = 0) => {
    const response = await suite.matrix(
      new Request(
        'http://x/_matrix/client/v3/sync?timeout=' + timeout +
          (since ? '&since=' + encodeURIComponent(since) : ''),
        { headers: { Authorization: 'Bearer ' + alice.access_token } },
      ),
    );
    assertEquals(response.status, 200, await response.clone().text());
    return await response.json() as SyncBody & {
      rooms: { join: Record<string, { timeline: { events: Json[] } }> };
    };
  };
  const initial = await sync();
  assertEquals(initial.to_device.events.length, 1);
  const actual = parseStreamToken(initial.next_batch)!;
  const future = encodeStreamToken({
    ...actual,
    eSeq: 999999,
    pSeq: 999999,
    rSeq: 999999,
    aSeq: 999999,
    dSeq: 999999,
    mSeq: 999999,
    kSeq: 999999,
    nSeq: 999999,
  });
  const bounded = await sync(future);
  assertEquals(
    bounded.to_device.events,
    initial.to_device.events,
    'bounding must not manufacture an issued inbox receipt',
  );
  assertEquals(parseStreamToken(bounded.next_batch)!.epoch, actual.epoch);
  const acknowledged = await sync(bounded.next_batch);
  assertEquals(acknowledged.to_device.events, []);
  const waitToken = encodeStreamToken({
    ...parseStreamToken(acknowledged.next_batch)!,
    eSeq: 999999,
  });
  const pending = sync(waitToken, 3000);
  // Allow the request to reach its ordinary wait owner before the new commit.
  await new Promise((resolve) => setTimeout(resolve, 80));
  const response = await suite.matrix(
    new Request(
      'http://x/_matrix/client/v3/rooms/' + encodeURIComponent(room.roomId) +
        '/send/m.room.message/new',
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + bob.access_token },
        body: JSON.stringify({ msgtype: 'm.text', body: 'after bounded cut' }),
      },
    ),
  );
  assertEquals(response.status, 200, await response.clone().text());
  const sent = await response.json() as { event_id: string };
  const result = await pending;
  assert(
    result.rooms.join[room.roomId]?.timeline.events.some((event) =>
      event.event_id === sent.event_id
    ),
    'a new lower-numbered event must wake and reach the future-token consumer',
  );
});

Deno.test('restore epoch: legacy tokens retain their grammar and invalid epochs are not accepted', () => {
  assertEquals(parseStreamToken('s1_p2')?.eSeq, 1);
  assertEquals(parseStreamToken('s1_z' + 'x'.repeat(32)), null);
  assertEquals(parseStreamToken('s1_z' + 'a'.repeat(31)), null);
  const valid = 's1_p2_t0_r0_a0_d0_m0_k0_z' + 'a'.repeat(32);
  assertEquals(encodeStreamToken(parseStreamToken(valid)!), valid);
});

Deno.test('future numeric bounding covers every durable component but retains typing, epoch and historical cuts', () => {
  const heads = {
    eSeq: 11,
    pSeq: 12,
    rSeq: 13,
    aSeq: 14,
    dSeq: 15,
    mSeq: 16,
    kSeq: 17,
    nSeq: 18,
  };
  const token = { ...heads, tSeq: 999999, epoch: 'a'.repeat(32) };
  assertEquals(boundFutureToken(token, heads), token);
  assert(boundFutureToken(token, heads) === token);
  for (const key of Object.keys(heads) as (keyof typeof heads)[]) {
    const forged = { ...token, [key]: 999999 };
    assertEquals(boundFutureToken(forged, heads), token);
    assertEquals(
      forged[key],
      999999,
      'the caller/receipt token must remain immutable',
    );
    const historical = { ...token, [key]: 0 };
    assert(boundFutureToken(historical, heads) === historical);
    assertEquals(
      parseStreamToken(encodeStreamToken(forged))![key],
      999999,
      'pagination parser is not a sync baseline repair',
    );
  }
});

function storage(dir: string) {
  return {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
}

Deno.test('restore report: no app workers start with an incomplete, missing or modified report; a completed report releases normal startup', async () => {
  const root = await Deno.makeTempDir({ prefix: 'restore-report-' });
  const settings = storage(join(root, 'live'));
  setConfigForTests({ media: { root: join(root, 'media') } });
  try {
    const app = await openApp(settings);
    await app.delayedEvents.stop();
    const cut = await app.store.snapshot(join(root, 'archive'));
    await closeApp();
    await copyPrivate(join(root, 'archive'), join(root, 'candidate'));
    let reportPath = '';
    const restored = storage(join(root, 'candidate'));
    await withCandidateStore(restored, restored.dir, cut.files, {
      room: roomSchema,
      tenant: tenantSchema,
      server: serverSchema,
    }, async (candidate) => {
      const server = candidate.files.find((f) => f.kind === 'server')!;
      const state = await candidate.tx(server, beginRecovery);
      assertEquals(
        (await candidate.read(server, recoveryState))?.reportSha256,
        null,
      );
      // Candidate access itself never releases the app's report boundary.
      await assertRejects(() => openApp(restored), Error, 'incomplete');
      reportPath = await writeRestoreReport(candidate, restored.dir, {
        format: 1,
        id: state.reportId,
        epoch: state.epoch,
        backupId: 'source-backup',
        cut: {
          started: '2026-11-13T20:00:00-08:00',
          completed: '2026-11-13T20:00:01-08:00',
        },
        restoredAt: '2026-11-13T22:00:00-08:00',
        audits: { passed: true },
        migrations: [],
        sanitation: {},
        pendingWork: { delayed: [], push: [], federation: [] },
        warnings: [
          'Post-cut acknowledgments and revocations cannot be recovered.',
        ],
      });
      assertEquals((await Deno.stat(reportPath)).mode! & 0o777, 0o600);
    });
    const good = await Deno.readTextFile(reportPath);
    await Deno.remove(reportPath);
    await assertRejects(() => openApp(restored), Deno.errors.NotFound);
    await Deno.writeTextFile(reportPath, good + ' ', { mode: 0o600 });
    await assertRejects(() => openApp(restored), Error, 'digest mismatch');
    await Deno.writeTextFile(reportPath, good, { mode: 0o600 });
    await openApp(restored);
    await closeApp();
    const raw = await openStore(restored, {
      schemas: { room: roomSchema, tenant: tenantSchema, server: serverSchema },
    });
    assert((await recoveryState(await raw.server()))?.reportSha256);
    await raw.close();
  } finally {
    await closeApp();
    setConfigForTests({});
    await Deno.remove(root, { recursive: true });
  }
});
