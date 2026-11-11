// Real task clients against a separately started main.ts, with its normal
// permission set. Bogus native-library config in every client proves no store
// is opened by a tool while the server owns the real file lock.
import { assert, assertEquals } from '@std/assert';
import metadata from '#root/deno.json' with { type: 'json' };

Deno.test('operator task clients preserve CLI contracts through the running server', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'operator-' });
  const socket = `${dir}/operator socket`;
  const config = `${dir}/communico.toml`;
  const probe = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = probe.addr.port;
  probe.close();
  await Deno.writeTextFile(
    config,
    `[server]\nport=${port}\n[store]\ndir="${dir}/store"\n[media]\nroot="${dir}/media"\n[admin]\nsocket="${socket}"\n[federation]\nenabled=false\ncert="${dir}/fed.crt"\nkey="${dir}/fed.key"\n`,
  );
  const env = { COMMUNICO_CONFIG: config, DENO_NO_PROMPT: '1' };
  const child = new Deno.Command(Deno.execPath(), {
    args: metadata.tasks.start.split(' ').slice(1),
    env,
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  let ended = false;
  const result = child.output().then((out) => {
    ended = true;
    return out;
  });
  const base = `http://127.0.0.1:${port}/_matrix/client/`;
  const cli = async (
    task: string,
    args: string[],
    code = 0,
    extra: Record<string, string> = {},
  ) => {
    const output = await new Deno.Command(Deno.execPath(), {
      args: ['task', task, '--', ...args],
      env: {
        ...env,
        COMMUNICO_STORE_LIBRARY: `${dir}/must-not-open.so`,
        ...extra,
      },
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    const stdout = new TextDecoder().decode(output.stdout),
      stderr = new TextDecoder().decode(output.stderr);
    assertEquals(
      output.code,
      code,
      `${task} ${args.join(' ')}: ${stdout}\n${stderr}`,
    );
    return { stdout, stderr };
  };
  const api = async (path: string, body?: unknown, token?: string) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  let token: string | undefined;
  try {
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        const response = await api('versions');
        assertEquals(response.status, 200);
        break;
      } catch {
        assert(!ended && Date.now() < deadline, 'main.ts did not start');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assertEquals(
      (await cli('federation-block', [
        'add',
        '*.cli.test',
        '--note',
        'reviewed note',
      ])).stdout,
      'blocked *.cli.test\n',
    );
    assert(
      (await cli('federation-block', ['list'])).stdout.includes(
        'note="reviewed note"',
      ),
    );
    assertEquals(
      (await cli('federation-block', ['remove', '*.cli.test'])).stdout,
      'unblocked *.cli.test\n',
    );
    assert(
      (await cli('federation-block', ['remove', '*.cli.test'], 1)).stderr
        .includes('*.cli.test not blocked'),
    );
    assertEquals(
      (await cli('federation-peer', [
        'add',
        'peer.test',
        '127.0.0.1:8448',
        '--trust',
        'pinned',
        '--cert',
        'tests/fixtures/tls/localhost.crt',
        '--note',
        'reviewed',
      ])).stdout,
      'added peer.test\n',
    );
    const peers = (await cli('federation-peer', ['list'])).stdout;
    assert(peers.includes('127.0.0.1:8448  trust=pinned pin='));
    assert(peers.includes('added_by=operator note="reviewed"'));
    assertEquals((await cli('federation-peer', ['pending'])).stdout, '');
    assertEquals(
      (await cli('federation-peer', ['approve', 'approved.test'])).stdout,
      'approved approved.test\n',
    );
    assertEquals(
      (await cli('federation-peer', ['reject', 'rejected.test', '--block']))
        .stdout,
      'rejected rejected.test (blocked)\n',
    );
    assert(
      (await cli('federation-block', ['list'])).stdout.includes(
        'rejected.test',
      ),
    );
    assertEquals(
      (await cli('federation-peer', ['remove', 'peer.test'])).stdout,
      'removed peer.test\n',
    );
    assert(
      (await cli('federation-peer', ['remove', 'peer.test'], 1)).stderr
        .includes('peer.test not on the roster'),
    );
    assertEquals((await cli('federation-key', ['list'])).stdout, '');
    assertEquals(
      (await cli('federation-key', ['forget', 'unknown.test'])).stdout,
      'forgot unknown.test - next contact is first contact\n',
    );
    assert(
      (await cli('federation-key', ['accept', 'unknown.test'], 1)).stderr
        .includes('no blocking key change for unknown.test'),
    );
    assertEquals(
      (await cli('federation-outbox', ['list'])).stdout,
      'outbox empty\n',
    );
    assertEquals(
      (await cli('federation-outbox', ['retry', 'delivery.test'])).stdout,
      'retry queued for delivery.test\n',
    );
    assert(
      (await cli('federation-outbox', ['list', 'delivery.test'])).stdout
        .includes('delivery.test: 0 queued, failures 0'),
    );
    await cli('federation-outbox', ['retry', 'unrelated.test']);
    assert(
      !(await cli('federation-outbox', ['list', 'delivery.test'])).stdout
        .includes('unrelated.test'),
      'destination selection must also filter status-only peers',
    );
    assert(
      (await cli('federation-outbox', ['list'])).stdout.includes(
        'unrelated.test',
      ),
      'omitted destination must retain status-only peers',
    );
    assertEquals(
      (await cli('federation-outbox', ['prune', 'delivery.test'])).stdout,
      'pruned 0 row(s) for delivery.test\n',
    );
    assertEquals((await cli('rooms', ['list'])).stdout, 'no rooms\n');
    assertEquals(
      (await cli('rooms', ['list', '--purgeable'])).stdout,
      'no rooms offered for purge\n',
    );
    const input = { username: 'operator-test', password: 'test-password' };
    const challenge = await api('v3/register', input);
    assertEquals(challenge.status, 401);
    const registered = await api('v3/register', {
      ...input,
      auth: { type: 'm.login.dummy', session: challenge.body.session },
    });
    assertEquals(registered.status, 200);
    token = registered.body.access_token;
    const room = await api('v3/createRoom', { room_version: '11' }, token);
    assertEquals(room.status, 200);
    const roomId = room.body.room_id as string;
    assert(
      (await cli('rooms', ['list'])).stdout.includes(`${roomId} (v11) stay `),
    );
    assertEquals(
      (await cli('rooms', ['purge', '--older-than', '0'])).stdout,
      'no rooms offered for purge\n',
    );
    assertEquals(
      (await cli('rooms', ['drop', roomId])).stdout,
      `dropped ${roomId} (database dropped, 0 outbox row(s) settled)\n`,
    );
    assertEquals((await cli('rooms', ['list'])).stdout, 'no rooms\n');
    const certificate = await cli('federation-cert', []);
    assert(
      certificate.stdout.startsWith(
        `wrote ${dir}/fed.crt + ${dir}/fed.key for CN=`,
      ),
    );
    assertEquals((await Deno.stat(`${dir}/fed.key`)).mode! & 0o7777, 0o600);
    assert(
      (await cli('federation-cert', [], 1)).stderr.includes(
        'refusing to overwrite existing',
      ),
    );
    assertEquals((await api('v3/logout', {}, token)).status, 200);
    assertEquals(
      (await api('v3/account/whoami', undefined, token)).status,
      401,
    );
    token = undefined;
    child.kill('SIGTERM');
    const output = await result;
    assertEquals(output.code, 0);
    assert(
      new TextDecoder().decode(output.stdout).includes(
        'shutdown: store closed',
      ),
    );
    try {
      await Deno.lstat(socket);
      throw new Error('socket retained after shutdown');
    } catch (error) {
      assert(error instanceof Deno.errors.NotFound);
    }
    for (
      const [task, args] of [
        ['federation-block', ['list']],
        ['federation-peer', ['list']],
        ['federation-key', ['list']],
        ['federation-outbox', ['list']],
        ['federation-cert', []],
        ['rooms', ['list']],
      ] as const
    ) {
      const failure = await cli(task, [...args], 1);
      assert(
        failure.stderr.includes('server is not running') &&
          failure.stderr.includes(socket),
      );
    }
    for (
      const [task, args] of [
        ['federation-block', []],
        ['federation-peer', ['add', 'x', '--trust', 'bad']],
        ['federation-key', ['accept']],
        ['federation-outbox', ['retry']],
        ['rooms', ['purge', '--older-than', 'bad']],
      ] as const
    ) {
      assert(
        (await cli(task, [...args], 2)).stderr.includes('usage: deno task'),
      );
    }
    const override = `${dir}/different.sock`;
    assert(
      (await cli('federation-block', ['list'], 1, {
        COMMUNICO_ADMIN_SOCKET: override,
      })).stderr.includes(override),
    );
  } finally {
    if (!ended) {
      if (token !== undefined) {
        await api('v3/logout', {}, token).catch(() => {});
      }
      child.kill('SIGTERM');
    }
    const output = await result;
    if (output.code !== 0) {
      console.error(new TextDecoder().decode(output.stderr));
    }
    await Deno.remove(dir, { recursive: true });
  }
});
