import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import metadata from '#root/deno.json' with { type: 'json' };

// Real task permissions, separate server processes and public consumers. The
// backup client receives an unusable native path to prove the live owner does it.
for (
  const [encrypted, defaultSocket] of [[false, false], [true, false], [
    false,
    true,
  ]]
) {
  Deno.test(`backup CLI: ${encrypted ? 'OpenPGP' : 'plaintext'}${defaultSocket ? ' default admin socket' : ''} running-server control round trip`, async () => {
    const dir = await Deno.makeTempDir({ prefix: "cli's-backup-" });
    const socket = join(dir, 'admin.sock');
    const config = join(dir, 'source.toml');
    const target = join(dir, 'target.toml');
    const bundle = join(dir, "server's backup");
    const passphrase = join(dir, 'passphrase');
    const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    const port = listener.addr.port;
    listener.close();
    const tlsListener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    const tlsPort = tlsListener.addr.port;
    tlsListener.close();
    await Deno.writeTextFile(passphrase, 'control passphrase\n', {
      mode: 0o600,
    });
    const common = `[server]\nname="control.test"\nport=${port}\n` +
      (defaultSocket ? '' : `[admin]\nsocket="${socket}"\n`) +
      `[federation]\nenabled=true\nport=${tlsPort}\ncert="tests/fixtures/tls/localhost.crt"\nkey="tests/fixtures/tls/localhost.key"\n[backup]\nencrypt=${encrypted}\npassphrasefile="${passphrase}"\n`;
    await Deno.writeTextFile(
      config,
      common +
        `[store]\ndir="${dir}/source"\n[media]\nroot="${dir}/source-media"\n`,
    );
    await Deno.writeTextFile(
      target,
      common +
        `[store]\ndir="${dir}/target"\n[media]\nroot="${dir}/target-media"\n`,
    );
    const env = { COMMUNICO_CONFIG: config, DENO_NO_PROMPT: '1' };
    let running: {
      child: Deno.ChildProcess;
      output: Promise<Deno.CommandOutput>;
      ended: boolean;
    } | null = null;
    const api = async (
      path: string,
      method = 'GET',
      body?: unknown,
      token?: string,
      expected = 200,
    ) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      assertEquals(response.status, expected, JSON.stringify(data));
      return data;
    };
    const start = async (configPath: string) => {
      const child = new Deno.Command(Deno.execPath(), {
        args: metadata.tasks.start.split(' ').slice(1),
        env: { ...env, COMMUNICO_CONFIG: configPath },
        stdout: 'piped',
        stderr: 'piped',
      }).spawn();
      const state = {
        child,
        output: Promise.resolve(null as unknown as Deno.CommandOutput),
        ended: false,
      };
      state.output = child.output().then((output) => {
        state.ended = true;
        return output;
      });
      running = state;
      const deadline = Date.now() + 15000;
      for (;;) {
        try {
          await api('/_matrix/client/versions');
          break;
        } catch {
          if (state.ended) {
            const output = await state.output;
            throw new Error(new TextDecoder().decode(output.stderr));
          }
          assert(Date.now() < deadline, 'server did not become ready');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    };
    const stop = async () => {
      if (running === null) return;
      if (!running.ended) running.child.kill('SIGTERM');
      const output = await running.output;
      running = null;
      assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
      assert(
        new TextDecoder().decode(output.stdout).includes(
          'shutdown: store closed',
        ),
      );
    };
    const cli = async (
      task: string,
      args: string[],
      configPath = config,
      expected = 0,
      extra: Record<string, string> = {},
    ) => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: ['task', task, '--', ...args],
        env: { ...env, COMMUNICO_CONFIG: configPath, ...extra },
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      const stdout = new TextDecoder().decode(result.stdout),
        stderr = new TextDecoder().decode(result.stderr);
      assertEquals(result.code, expected, `${task}: ${stdout}\n${stderr}`);
      return { stdout, stderr };
    };
    try {
      await start(config);
      const register = async (username: string) => {
        const input = {
          username,
          password: 'control-password',
          device_id: 'PHONE',
        };
        const challenge = await api(
          '/_matrix/client/v3/register',
          'POST',
          input,
          undefined,
          401,
        );
        return await api('/_matrix/client/v3/register', 'POST', {
          ...input,
          auth: { type: 'm.login.dummy', session: challenge.session },
        });
      };
      const alice = await register('alice'), bob = await register('bob');
      const room = (await api('/_matrix/client/v3/createRoom', 'POST', {
        room_version: '11',
        name: 'Restored room',
        preset: 'public_chat',
      }, alice.access_token)).room_id;
      const roomPath = '/_matrix/client/v3/rooms/' + encodeURIComponent(room);
      await api(roomPath + '/join', 'POST', {}, bob.access_token);
      const event =
        (await api(roomPath + '/send/m.room.message/before', 'PUT', {
          msgtype: 'm.text',
          body: 'kept across restore',
        }, alice.access_token)).event_id;
      const accountPath = '/_matrix/client/v3/user/' +
        encodeURIComponent(alice.user_id) + '/account_data/control.example';
      await api(accountPath, 'PUT', { retained: true }, alice.access_token);
      const bytes = new TextEncoder().encode('opaque attachment ciphertext');
      const upload = await fetch(
        `http://127.0.0.1:${port}/_matrix/media/v3/upload`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${alice.access_token}`,
            'content-type': 'application/octet-stream',
          },
          body: bytes,
        },
      );
      assertEquals(upload.status, 200);
      const mxc = (await upload.json()).content_uri as string;
      const keys = await api('/_matrix/key/v2/server');
      const publicAdmin = await fetch(`http://127.0.0.1:${port}/v1/backup`, {
        method: 'POST',
        body: JSON.stringify({ destination: bundle }),
      });
      assertEquals(publicAdmin.status, 404);
      await publicAdmin.body?.cancel();
      const backed = JSON.parse(
        (await cli('backup', [bundle], config, 0, {
          COMMUNICO_STORE_LIBRARY: join(dir, 'must-not-open.so'),
        })).stdout,
      );
      assertEquals(backed.path, bundle);
      assert(backed.pauseMs >= 0);
      assertEquals(
        (await api(
          '/_matrix/client/v3/account/whoami',
          'GET',
          undefined,
          alice.access_token,
        )).user_id,
        alice.user_id,
      );
      await cli('backup', [bundle], config, 1);
      await cli('restore', [bundle, '--replace'], config, 1);
      await cli('backup', [], config, 2);
      await cli('restore', [bundle, '--unknown'], target, 2);
      // The post-cut write must stay on the old installation, not leak into A.
      const late =
        (await api(roomPath + '/send/m.room.message/after-cut', 'PUT', {
          msgtype: 'm.text',
          body: 'post-cut only',
        }, alice.access_token)).event_id;
      await stop();
      await cli('backup', [join(dir, 'offline')], config, 1);
      const restored = JSON.parse(
        (await cli('restore', [bundle], target)).stdout,
      );
      assertEquals(restored.path, join(dir, 'target'));
      assertEquals((await Deno.stat(restored.reportPath)).mode! & 0o777, 0o600);
      await cli('restore', [bundle], target, 1);
      await start(restored.configPath);
      await cli('restore', [bundle, '--replace'], target, 1);
      assertEquals(
        (await api('/_matrix/key/v2/server')).verify_keys,
        keys.verify_keys,
      );
      for (const user of [alice, bob]) {
        assertEquals(
          (await api(
            '/_matrix/client/v3/account/whoami',
            'GET',
            undefined,
            user.access_token,
          )).user_id,
          user.user_id,
        );
        const joined = await api(
          '/_matrix/client/v3/joined_rooms',
          'GET',
          undefined,
          user.access_token,
        );
        assert(joined.joined_rooms.includes(room));
        const held = await api(
          roomPath + '/event/' + encodeURIComponent(event),
          'GET',
          undefined,
          user.access_token,
        );
        assertEquals(held.content.body, 'kept across restore');
        await api(
          roomPath + '/event/' + encodeURIComponent(late),
          'GET',
          undefined,
          user.access_token,
          404,
        );
      }
      const login = await api('/_matrix/client/v3/login', 'POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: 'control-password',
        device_id: 'NEW',
      });
      assertEquals(login.user_id, alice.user_id);
      assertEquals(
        await api(accountPath, 'GET', undefined, login.access_token),
        { retained: true },
      );
      const sync = await api(
        '/_matrix/client/v3/sync',
        'GET',
        undefined,
        bob.access_token,
      );
      assert(
        sync.rooms.join[room].timeline.events.some((e: { event_id: string }) =>
          e.event_id === event
        ),
      );
      const download = await fetch(
        `http://127.0.0.1:${port}/_matrix/client/v1/media/download/${
          mxc.slice('mxc://'.length)
        }`,
        { headers: { authorization: `Bearer ${bob.access_token}` } },
      );
      assertEquals(download.status, 200);
      assertEquals(new Uint8Array(await download.arrayBuffer()), bytes);
      const next =
        (await api(roomPath + '/send/m.room.message/restored', 'PUT', {
          msgtype: 'm.text',
          body: 'new on restored server',
        }, bob.access_token)).event_id;
      assertEquals(
        (await api(
          roomPath + '/event/' + encodeURIComponent(next),
          'GET',
          undefined,
          alice.access_token,
        )).content.body,
        'new on restored server',
      );
      for (
        const token of [
          alice.access_token,
          bob.access_token,
          login.access_token,
        ]
      ) await api('/_matrix/client/v3/logout', 'POST', {}, token);
      await stop();
    } finally {
      await stop();
      await Deno.remove(dir, { recursive: true });
    }
  });
}
