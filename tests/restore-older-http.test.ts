import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { pathfinder } from '@pathfinder/pathfinder';
import { closeApp, openApp } from '#engine/app.ts';
import { loadConfig, loadedConfig, setConfigForTests } from '#engine/config.ts';
import { createBackup } from '#engine/backup/bundle.ts';
import { restoreBackup } from '#engine/backup/restore.ts';
import { describePayload, readManifest } from '#engine/backup/manifest.ts';
import { assertSpecHttpResponse } from '#tests/spec-contract.ts';

type Json = Record<string, unknown>;
const object = (value: unknown) => value as Json;
const client = '/_matrix/client/v3';
const sliding = '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync';

Deno.test('older archive over HTTP: consumed keys never reappear and newer ordinary/list/encryption positions recover without replacing client identity', async (t) => {
  const root = await Deno.makeTempDir({ prefix: 'restore-older-http-' });
  const settings = loadedConfig();
  const cfg = {
    ...structuredClone(settings.config),
    store: {
      ...settings.config.store,
      dir: join(root, 'live'),
      library: './.native/libturso_ffi.so',
    },
    media: { ...settings.config.media, root: join(root, 'media') },
    federation: { ...settings.config.federation, enabled: false },
  };
  setConfigForTests(cfg);
  let server: Deno.HttpServer<Deno.NetAddr> | undefined;
  let base = '';
  const handler = await pathfinder({ roots: ['api/endpoints/matrix/'] });
  const listen = () => {
    server = Deno.serve({
      hostname: '127.0.0.1',
      port: 0,
      onListen: () => {},
    }, handler);
    base = 'http://127.0.0.1:' + server.addr.port;
  };
  async function call(
    path: string,
    token?: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
    status = 200,
  ): Promise<Json> {
    const request = new Request(base + path, {
      method,
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const response = await fetch(request);
    assertEquals(response.status, status, await response.clone().text());
    await assertSpecHttpResponse(request, response);
    return await response.json();
  }
  try {
    const app = await openApp(cfg.store);
    listen();
    const register = async (username: string, device: string) => {
      const input = {
        username,
        password: 'older-archive-password',
        device_id: device,
      };
      const challenge = await call(
        client + '/register',
        undefined,
        input,
        'POST',
        401,
      );
      const result = await call(client + '/register', undefined, {
        ...input,
        auth: { type: 'm.login.dummy', session: challenge.session },
      });
      return {
        user: String(result.user_id),
        device: String(result.device_id),
        token: String(result.access_token),
      };
    };
    const alice = await register('older-alice', 'RETAINED');
    const bob = await register('older-bob', 'OBSERVER');
    const room = String(
      (await call(client + '/createRoom', alice.token, {
        preset: 'public_chat',
        name: 'Snapshot A name',
      })).room_id,
    );
    const roomPath = client + '/rooms/' + encodeURIComponent(room);
    await call(client + '/join/' + encodeURIComponent(room), bob.token, {});
    const account = client + '/user/' + encodeURIComponent(alice.user) +
      '/account_data/restore.older';
    await call(account, alice.token, { version: 'A' }, 'PUT');
    const deviceKeys = {
      user_id: alice.user,
      device_id: alice.device,
      algorithms: ['m.olm.v1.curve25519-aes-sha2'],
      keys: { 'curve25519:RETAINED': 'retained-public-device-key' },
      signatures: {},
    };
    const upload = (body: unknown) =>
      call(client + '/keys/upload', alice.token, body);
    const claim = async () => {
      const result = await call(client + '/keys/claim', bob.token, {
        one_time_keys: { [alice.user]: { [alice.device]: 'curve25519' } },
      });
      return object(object(result.one_time_keys)[alice.user] ?? {})[
        alice
          .device
      ];
    };
    await upload({
      device_keys: deviceKeys,
      one_time_keys: { 'curve25519:archive-once': 'consumed-after-cut' },
      fallback_keys: { 'curve25519:archive-fallback': 'rotated-after-cut' },
    });
    const publicKeysA = await call(client + '/keys/query', bob.token, {
      device_keys: { [alice.user]: [alice.device] },
    });
    await call(client + '/sendToDevice/m.test/retained', bob.token, {
      messages: {
        [alice.user]: { [alice.device]: { source: 'archive A inbox' } },
      },
    }, 'PUT');
    const sync = (since?: string) =>
      call(
        client + '/sync?timeout=0' +
          (since ? '&since=' + encodeURIComponent(since) : ''),
        alice.token,
      );
    const listRequest = {
      conn_id: 'room-list',
      lists: {
        main: {
          ranges: [[0, 19]],
          required_state: [['m.room.name', '']],
          timeline_limit: 10,
        },
      },
    };
    const encryptionRequest = {
      conn_id: 'encryption',
      extensions: { e2ee: { enabled: true } },
    };
    const slide = (request: unknown, pos?: string, status = 200) =>
      call(
        sliding + '?timeout=0' +
          (pos ? '&pos=' + encodeURIComponent(pos) : ''),
        alice.token,
        request,
        'POST',
        status,
      );
    const ordinaryA = await sync();
    assertEquals(object(ordinaryA.to_device).events, [{
      sender: bob.user,
      type: 'm.test',
      content: { source: 'archive A inbox' },
    }]);
    const listA = await slide(listRequest);
    const encryptionA = await slide(encryptionRequest);
    const bundle = join(root, 'archive-A');
    await createBackup(app.store, bundle, {
      ...settings,
      config: cfg,
      configPath: null,
    });
    const manifest = await readManifest(bundle);
    const digests = await Promise.all(
      manifest.payloads.map((file) =>
        describePayload(bundle, file.stored.path)
      ),
    );

    // These are real B-side consumers, not synthetic future numeric tokens.
    assertEquals(await claim(), {
      'curve25519:archive-once': 'consumed-after-cut',
    });
    assertEquals(await claim(), {
      'curve25519:archive-fallback': 'rotated-after-cut',
    });
    await upload({
      fallback_keys: { 'curve25519:B-fallback': 'new-private-half-at-B' },
    });
    await call(account, alice.token, { version: 'B' }, 'PUT');
    await call(roomPath + '/state/m.room.name/', alice.token, {
      name: 'Newer B name',
    }, 'PUT');
    const postcut = await call(
      roomPath + '/send/m.room.message/postcut',
      bob.token,
      { msgtype: 'm.text', body: 'acknowledged after A' },
      'PUT',
    );
    const ordinaryB = await sync(String(ordinaryA.next_batch));
    assertEquals(object(ordinaryB.to_device).events, []);
    const listB = await slide(listRequest, String(listA.pos));
    const encryptionB = await slide(encryptionRequest, String(encryptionA.pos));

    await server!.shutdown();
    server = undefined;
    await closeApp();
    const result = await restoreBackup(bundle, {}, {
      ...settings,
      configPath: null,
      config: {
        ...cfg,
        store: { ...cfg.store, dir: join(root, 'restored') },
        media: { ...cfg.media, root: join(root, 'restored-media') },
      },
    });
    const restored = loadConfig({
      defaultsPath: settings.defaultsPath,
      configPath: result.configPath,
      env: {},
    });
    setConfigForTests(restored.config);
    await openApp(restored.config.store);
    listen();

    await t.step(
      'A consuming pools are empty before any refill; B-consumed material is never reissued',
      async () => {
        assertEquals((await upload({})).one_time_key_counts, {});
        assertEquals(await claim(), undefined);
        const reset = await sync(String(ordinaryB.next_batch));
        assertEquals(reset.device_one_time_keys_count, {});
        assertEquals(reset.device_unused_fallback_key_types, []);
        const queried = await call(client + '/keys/query', bob.token, {
          device_keys: { [alice.user]: [alice.device] },
        });
        assertEquals(
          queried.device_keys,
          publicKeysA.device_keys,
        );
        await upload({
          one_time_keys: { 'curve25519:restored-once': 'fresh-private-half' },
          fallback_keys: { 'curve25519:restored-fallback': 'fresh-fallback' },
        });
        assertEquals(await claim(), {
          'curve25519:restored-once': 'fresh-private-half',
        });
        assertEquals(await claim(), {
          'curve25519:restored-fallback': 'fresh-fallback',
        });
      },
    );

    await t.step(
      'retained B ordinary token resets all state and cannot acknowledge A inbox',
      async () => {
        const reset = await sync(String(ordinaryB.next_batch));
        assert(String(reset.next_batch).includes('_z' + result.report.epoch));
        assertEquals(
          object(reset.to_device).events,
          object(ordinaryA.to_device).events,
        );
        assertEquals(
          (object(reset.account_data).events as Json[]).find((event) =>
            event.type === 'restore.older'
          )?.content,
          { version: 'A' },
        );
        const joined = object(object(reset.rooms).join);
        // Ordinary sync applies state-at-start followed by timeline state.
        const entry = object(joined[room]);
        const state = [
          ...object(entry.state).events as Json[],
          ...object(entry.timeline).events as Json[],
        ];
        assertEquals(
          state.find((event) => event.type === 'm.room.name')?.content,
          { name: 'Snapshot A name' },
        );
        assertEquals(
          object((await sync(String(reset.next_batch))).to_device).events,
          [],
        );
        await call(
          roomPath + '/event/' + encodeURIComponent(String(postcut.event_id)),
          alice.token,
          undefined,
          'GET',
          404,
        );
        // Outrun B's actual event/account-data heads, then retry its same token.
        for (let n = 0; n < 4; n++) {
          await call(account, alice.token, { version: 'restored-' + n }, 'PUT');
          await call(
            roomPath + '/send/m.room.message/restored-' + n,
            bob.token,
            {
              msgtype: 'm.text',
              body: 'new accepted message ' + n,
            },
            'PUT',
          );
        }
        const again = await sync(String(ordinaryB.next_batch));
        assert(object(object(again.rooms).join)[room]);
        assertEquals(
          (object(again.account_data).events as Json[]).find((event) =>
            event.type === 'restore.older'
          )?.content,
          { version: 'restored-3' },
        );
      },
    );

    await t.step(
      'both retained B sliding connections reject old positions and return current initial data',
      async () => {
        for (
          const [request, previous] of [
            [listRequest, listB],
            [encryptionRequest, encryptionB],
          ] as const
        ) {
          assertEquals(
            (await slide(request, String(previous.pos), 400)).errcode,
            'M_UNKNOWN_POS',
          );
        }
        const list = await slide(listRequest);
        assert(object(list.rooms)[room]);
        const encryption = await slide(encryptionRequest);
        assertEquals(
          object(object(encryption.extensions).e2ee).device_one_time_keys_count,
          {},
        );
        assertEquals(
          await Promise.all(
            manifest.payloads.map((file) =>
              describePayload(bundle, file.stored.path)
            ),
          ),
          digests,
        );
        assertEquals(
          (await call(client + '/account/whoami', alice.token)).device_id,
          alice.device,
        );
      },
    );
  } finally {
    await server?.shutdown();
    await closeApp();
    setConfigForTests({});
    await Deno.remove(root, { recursive: true });
  }
});
