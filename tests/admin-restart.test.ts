import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  adminSocket,
  ConfigError,
  loadConfig,
  validateAdminSocketPath,
} from '#engine/config.ts';
import { startAdmin } from '#root/api/admin/index.ts';
import { startHttp } from './http-app.ts';
import metadata from '#root/deno.json' with { type: 'json' };
import {
  bounded,
  partialRequest,
  pause,
  serverProcess,
} from './helpers/server-process.ts';

const decode = (out: Uint8Array) => new TextDecoder().decode(out);
async function tool(config: string) {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ['task', 'federation-block', '--', 'list'],
    env: { COMMUNICO_CONFIG: config },
  }).output();
  assertEquals(out.code, 0, decode(out.stderr));
  return decode(out.stdout);
}

Deno.test('admin socket limit is absolute UTF-8 bytes, shared by config, bind and tools', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'path-' });
  const http = await startHttp();
  try {
    const path107 = `${dir}/${
      'x'.repeat(106 - new TextEncoder().encode(dir).length)
    }`;
    assertEquals(new TextEncoder().encode(path107).length, 107);
    const loaded = loadConfig({
      defaultsPath: 'defaults/communico.toml',
      configPath: null,
      env: { COMMUNICO_ADMIN_SOCKET: path107 },
    });
    assertEquals(adminSocket(loaded.config), path107);
    const admin = await startAdmin(http.app, path107);
    await admin.shutdown();
    for (const path of [path107 + 'x', path107.slice(0, -1) + '\u00e9']) {
      const message =
        `admin socket path exceeds 107 bytes: ${path} (108 bytes)`;
      assertThrows(
        () =>
          loadConfig({
            defaultsPath: 'defaults/communico.toml',
            configPath: null,
            env: { COMMUNICO_ADMIN_SOCKET: path },
          }),
        ConfigError,
        message,
      );
      await assertRejects(() => startAdmin(http.app, path), Error, message);
      const out = await new Deno.Command(Deno.execPath(), {
        args: ['task', 'federation-block', '--', 'list'],
        env: { COMMUNICO_ADMIN_SOCKET: path },
      }).output();
      assertEquals(out.code, 1);
      assert(decode(out.stderr).includes(message), decode(out.stderr));
    }
    const relative = 'x'.repeat(107);
    assertThrows(
      () => validateAdminSocketPath(relative),
      Error,
      `${Deno.cwd()}/${relative}`,
    );
    assertThrows(
      () =>
        loadConfig({
          defaultsPath: 'defaults/communico.toml',
          configPath: null,
          env: { COMMUNICO_STORE_DIR: '/' + 's'.repeat(108) + '/store' },
        }),
      ConfigError,
      'admin socket path exceeds 107 bytes',
    );
  } finally {
    await http.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('restart cannot acquire store until old admin listener is gone; old exit preserves new socket', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'restart-' });
  const barrier = `${dir}/exit-allowed`;
  const old = await serverProcess({ dir, exitBarrier: barrier });
  let replacement: Awaited<ReturnType<typeof serverProcess>> | undefined;
  const pending = await partialRequest(old, '/v1/status', '{}');
  try {
    const original = await Deno.lstat(old.socket);
    await pause(100);
    old.child.kill('SIGTERM');
    await old.waitLog('shutdown: draining');
    // A second real main cannot open the store while the old listener drains.
    const contender = await bounded(new Deno.Command(Deno.execPath(), {
      args: metadata.tasks.start.split(' ').slice(1),
      env: { COMMUNICO_CONFIG: old.config },
    }).output());
    assert(contender.code !== 0);
    assert(
      /lock|busy|in use/i.test(decode(contender.stderr)),
      decode(contender.stderr),
    );
    assertEquals((await Deno.lstat(old.socket)).ino, original.ino);
    assert((await pending.finish()).includes('"ok":true'));
    await old.waitLog('test: exit deferred');
    assertEquals(await Deno.lstat(old.socket).catch(() => null), null);
    replacement = await serverProcess({ dir });
    assertEquals(await tool(replacement.config), '');
    const bound = await Deno.lstat(replacement.socket);
    await Deno.writeTextFile(barrier, 'exit');
    assertEquals((await bounded(old.output)).code, 0);
    assertEquals((await Deno.lstat(replacement.socket)).ino, bound.ino);
    assertEquals(await tool(replacement.config), '');
    assertEquals((await replacement.api('versions')).status, 200);
    replacement.child.kill('SIGTERM');
    assertEquals((await bounded(replacement.output)).code, 0);
  } finally {
    await old.dispose();
    await replacement?.dispose();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('SIGKILL leaves a stale socket; restart removes it and tools reconnect', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'killed-' });
  const old = await serverProcess({ dir });
  let replacement: Awaited<ReturnType<typeof serverProcess>> | undefined;
  try {
    assertEquals(await tool(old.config), '');
    old.child.kill('SIGKILL');
    assert(!(await bounded(old.output)).success);
    assert((await Deno.lstat(old.socket)).isSocket);
    replacement = await serverProcess({ dir });
    assertEquals(await tool(replacement.config), '');
    assertEquals((await replacement.api('versions')).status, 200);
    replacement.child.kill('SIGTERM');
    assertEquals((await bounded(replacement.output)).code, 0);
    assertEquals(await Deno.lstat(replacement.socket).catch(() => null), null);
  } finally {
    await old.dispose();
    await replacement?.dispose();
    await Deno.remove(dir, { recursive: true });
  }
});
