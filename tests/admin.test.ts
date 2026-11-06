import { assert, assertEquals, assertRejects } from '@std/assert';
import { startAdmin } from '#root/api/admin/index.ts';
import { startHttp } from '#tests/http-app.ts';
import { adminSocket, loadConfig } from '#engine/config.ts';

async function call(path: string, route = '/v1/status', body = '{}') {
  const output = await new Deno.Command('curl', {
    args: [
      '--silent',
      '--show-error',
      '--max-time',
      '5',
      '--unix-socket',
      path,
      '-H',
      'Content-Type: application/json',
      '-d',
      body,
      `http://localhost${route}`,
    ],
  }).output();
  assert(output.success, new TextDecoder().decode(output.stderr));
  return JSON.parse(new TextDecoder().decode(output.stdout));
}

Deno.test('admin config socket default follows store and env overrides it', () => {
  const loaded = loadConfig({
    defaultsPath: 'defaults/communico.toml',
    configPath: null,
    env: { COMMUNICO_STORE_DIR: '/data/instance/store' },
  });
  assertEquals(adminSocket(loaded.config), '/data/instance/admin.sock');
  const overridden = loadConfig({
    defaultsPath: 'defaults/communico.toml',
    configPath: null,
    env: { COMMUNICO_ADMIN_SOCKET: '/data/operator.sock' },
  });
  assertEquals(adminSocket(overridden.config), '/data/operator.sock');
});

Deno.test('admin status, private socket, stale/live ownership and public isolation', async (t) => {
  const dir = await Deno.makeTempDir({ prefix: 'admin-' });
  const http = await startHttp();
  const path = `${dir}/admin.sock`;
  let admin: Awaited<ReturnType<typeof startAdmin>> | null = null;
  try {
    await t.step('stale socket removed', async () => {
      const stale = Deno.listen({ transport: 'unix', path });
      stale.close();
      // Runtime versions may remove a closed listener's path themselves.
      try {
        await Deno.lstat(path);
      } catch {
        const child = new Deno.Command('python3', {
          args: [
            '-c',
            'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()',
            path,
          ],
        });
        assert((await child.output()).success);
      }
      admin = await startAdmin(http.app, path);
      const result = await call(path);
      assert(result.ok);
      assertEquals(result.result.server, http.app.tenant.serverName);
      assertEquals(result.result.version, '0.1.0-dev');
      assert(result.result.uptime >= 0);
    });
    await t.step('mode 0600 and umask restored', async () => {
      assertEquals((await Deno.lstat(path)).mode! & 0o7777, 0o600);
      assertEquals((await Deno.lstat(path)).uid, Deno.uid());
    });
    await t.step('live socket refuses second start', async () => {
      await assertRejects(
        () => startAdmin(http.app, path),
        Error,
        'another server owns this store',
      );
      assert((await call(path)).ok);
    });
    await t.step('public listener cannot invoke admin', async () => {
      const response = await http.matrix(
        new Request('http://localhost/v1/status', {
          method: 'POST',
          body: '{}',
        }),
      );
      assertEquals(response.status, 404);
      await response.body?.cancel();
    });
    await t.step('version, method and JSON errors have envelopes', async () => {
      assertEquals((await call(path, '/v2/status')).error.code, 'NOT_FOUND');
      assertEquals(
        (await call(path, '/v1/status', 'null')).error.code,
        'BAD_REQUEST',
      );
      assertEquals(
        (await call(path, '/v1/status', '{')).error.code,
        'BAD_REQUEST',
      );
    });
    await admin!.shutdown();
    admin = null;
    await assertRejects(() => Deno.lstat(path), Deno.errors.NotFound);
    await Deno.writeTextFile(path, 'preserve');
    await assertRejects(
      () => startAdmin(http.app, path),
      Error,
      'refusing to remove',
    );
    assertEquals(await Deno.readTextFile(path), 'preserve');
  } finally {
    await (admin as Awaited<ReturnType<typeof startAdmin>> | null)?.shutdown();
    await http.close();
    await Deno.remove(dir, { recursive: true });
  }
});
