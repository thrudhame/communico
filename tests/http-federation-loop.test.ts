// Production main.ts processes: every client and federation hop uses the real
// route tree. TLS is verified against the existing fixture CA, with no fake
// federation transport, engine seeding or private diagnostic endpoints.
import { assert, assertEquals } from '@std/assert';

type Json = Record<string, unknown>;
const fixture = Deno.cwd() + '/tests/fixtures/tls/';
const enc = encodeURIComponent;

async function waitFor(probe: () => Promise<boolean>, label: string) {
  const end = Date.now() + 20_000;
  while (!await probe()) {
    assert(Date.now() < end, 'timed out: ' + label);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function start(dir: string) {
  const httpReservation = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const tlsReservation = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const httpPort = (httpReservation.addr as Deno.NetAddr).port;
  const tlsPort = (tlsReservation.addr as Deno.NetAddr).port;
  const name = 'localhost:' + tlsPort;
  await Deno.mkdir(dir);
  const overlay = dir + '/communico.toml';
  await Deno.writeTextFile(
    overlay,
    `[server]
name="${name}"
port=${httpPort}
[store]
dir="${dir}/store"
[federation]
enabled=true
port=${tlsPort}
cert="${fixture}localhost.crt"
key="${fixture}localhost.key"
cacerts=["${fixture}ca.crt"]
backfillbatch=2
`,
  );
  httpReservation.close();
  tlsReservation.close();
  const child = new Deno.Command(Deno.execPath(), {
    args: ['run', '--allow-all', 'main.ts'],
    env: { COMMUNICO_CONFIG: overlay },
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  let log = '';
  async function collect(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      log += decoder.decode(chunk, { stream: true });
    }
    log += decoder.decode();
  }
  const output = Promise.all([collect(child.stdout), collect(child.stderr)]);
  let exited = false;
  const status = child.status.then((result) => {
    exited = true;
    return result;
  });
  const tls = Deno.createHttpClient({
    caCerts: [await Deno.readTextFile(fixture + 'ca.crt')],
  });
  const call = async (
    path: string,
    token?: string,
    body?: Json,
    method = 'GET',
  ) => {
    const res = await fetch(
      'http://127.0.0.1:' + httpPort + '/_matrix/client/v3/' + path,
      {
        method,
        headers: token === undefined
          ? {}
          : { authorization: 'Bearer ' + token },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    return { status: res.status, body: await res.json() as Json };
  };
  const stop = async () => {
    try {
      if (!exited) child.kill('SIGTERM');
      const result = await status;
      await output;
      assertEquals(result.code, 0);
      assert(log.includes('shutdown: store closed'));
    } finally {
      tls.close();
    }
  };
  try {
    await waitFor(async () => {
      assert(!exited, log);
      try {
        const res = await fetch(
          'https://' + name + '/_matrix/federation/v1/version',
          { client: tls },
        );
        const body = await res.json();
        return res.status === 200 && body.server.name === 'communico';
      } catch {
        return false;
      }
    }, name + ' cold TLS startup');
  } catch (error) {
    await stop();
    throw error;
  }
  return { name, call, stop, logs: () => log };
}

type Instance = Awaited<ReturnType<typeof start>>;
async function register(instance: Instance, username: string) {
  const body = { username, password: 'test-password' };
  const challenge = await instance.call('register', undefined, body, 'POST');
  assertEquals(challenge.status, 401);
  const answer = await instance.call('register', undefined, {
    ...body,
    auth: { type: 'm.login.dummy', session: challenge.body.session },
  }, 'POST');
  assertEquals(answer.status, 200);
  return {
    user: answer.body.user_id as string,
    token: answer.body.access_token as string,
  };
}

Deno.test('HTTP/TLS loop: create -> invite -> join -> messages -> backfill -> converge', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'http-federation-loop-' });
  const a = await start(dir + '/a');
  let b: Instance | undefined;
  try {
    b = await start(dir + '/b');
    const alice = await register(a, 'alice');
    const bob = await register(b, 'bob');
    const created = await a.call('createRoom', alice.token, {
      preset: 'private_chat',
    }, 'POST');
    assertEquals(created.status, 200);
    const room = created.body.room_id as string;
    const base = 'rooms/' + enc(room);
    const say = async (instance: Instance, token: string, body: string) => {
      const result = await instance.call(
        base + '/send/m.room.message/' + crypto.randomUUID(),
        token,
        { msgtype: 'm.text', body },
        'PUT',
      );
      assertEquals(result.status, 200, JSON.stringify(result.body));
      return result.body.event_id as string;
    };
    assertEquals(
      (await a.call(base + '/state/m.room.name', alice.token, {
        name: 'old name',
      }, 'PUT')).status,
      200,
    );
    const old = await say(a, alice.token, 'history before B joined');
    assertEquals(
      (await a.call(base + '/state/m.room.name', alice.token, {
        name: 'current name',
      }, 'PUT')).status,
      200,
    );
    const invited = await a.call(base + '/invite', alice.token, {
      user_id: bob.user,
    }, 'POST');
    assertEquals(invited.status, 200, JSON.stringify(invited.body));
    // No via override: B must have received the invite through its real v2
    // invite route to discover A and complete make_join/send_join.
    const joined = await b.call(base + '/join', bob.token, {}, 'POST');
    assertEquals(joined.status, 200, JSON.stringify(joined.body));
    const membership = await a.call(
      base + '/state/m.room.member/' + enc(bob.user),
      alice.token,
    );
    assertEquals(membership.body.membership, 'join');
    // Stage 5b restores public remote profiles from the real received member
    // event. Both local and remote identifiers here carry a server port.
    const bobProfile = 'profile/' + enc(bob.user);
    assertEquals(await b.call(bobProfile), {
      status: 200,
      body: { displayname: 'bob' },
    });
    assertEquals(await a.call(bobProfile), {
      status: 200,
      body: { displayname: 'bob' },
    });
    assertEquals((await a.call(bobProfile + '/displayname')).body, {
      displayname: 'bob',
    });
    assertEquals((await a.call(bobProfile + '/avatar_url')).body, {});
    const eventPath = (id: string) => base + '/event/' + enc(id);
    assertEquals((await b.call(eventPath(old), bob.token)).status, 404);
    const fromA = await say(a, alice.token, 'message A -> B');
    const fromB = await say(b, bob.token, 'message B -> A');
    const peer = b;
    await waitFor(
      async () => (await peer.call(eventPath(fromA), bob.token)).status === 200,
      'A message at B',
    );
    await waitFor(
      async () => (await a.call(eventPath(fromB), alice.token)).status === 200,
      'B message at A',
    );
    // Small backfill batches force page-edge /state_ids and /event reads
    // (old name is absent from the join snapshot), not only a complete page
    // back to create. Stable cursors must continue across prepended segments.
    const readAll = async (instance: Instance, token: string) => {
      const events: Json[] = [];
      let cursor = '';
      for (let page = 0; page < 30; page++) {
        const result = await instance.call(
          base + '/messages?dir=b&limit=100' +
            (cursor === '' ? '' : '&from=' + enc(cursor)),
          token,
        );
        assertEquals(result.status, 200, JSON.stringify(result.body));
        events.push(...result.body.chunk as Json[]);
        if (result.body.end === undefined) {
          assertEquals(
            new Set(events.map((e) => e.event_id)).size,
            events.length,
          );
          return events;
        }
        cursor = String(result.body.end);
      }
      throw new Error('history pagination did not finish');
    };
    const eventsB = await readAll(b, bob.token);
    assert(
      eventsB.some((e) =>
        e.event_id === old &&
        (e.content as Json).body === 'history before B joined'
      ),
    );
    const recovered = await b.call(eventPath(old), bob.token);
    assertEquals(recovered.status, 200);
    assertEquals(
      (recovered.body.content as Json).body,
      'history before B joined',
    );
    const eventsA = await readAll(a, alice.token);
    assertEquals(
      eventsB.map((e) => e.event_id).sort(),
      eventsA.map((e) => e.event_id).sort(),
    );
    const digest = async (instance: Instance, token: string) => {
      const response = await instance.call(base + '/state', token);
      assertEquals(response.status, 200);
      return (response.body as unknown as Json[]).map((e) =>
        [e.type, e.state_key, e.event_id].join('|')
      ).sort();
    };
    assertEquals(await digest(b, bob.token), await digest(a, alice.token));
    const aLog = a.logs();
    const bLog = b.logs();
    for (
      const route of [
        '/_matrix/federation/v1/make_join/',
        '/_matrix/federation/v2/send_join/',
        '/_matrix/federation/v1/backfill/',
        '/_matrix/federation/v1/state_ids/',
        '/_matrix/federation/v1/event/',
        '/_matrix/federation/v1/send/',
      ]
    ) {
      assert(aLog.includes(route), 'A did not observe ' + route);
    }
    assert(
      bLog.includes('/_matrix/federation/v2/invite/'),
      'B did not receive the invite route',
    );
    assert(
      bLog.includes('/_matrix/federation/v1/send/'),
      'B did not receive the transaction route',
    );
    console.log(
      'real-route TLS proof:',
      JSON.stringify({
        room,
        old,
        fromA,
        fromB,
        events: eventsB.length,
        state: (await digest(b, bob.token)).length,
      }),
    );
  } catch (error) {
    console.error('A main.ts log:', a.logs());
    if (b !== undefined) console.error('B main.ts log:', b.logs());
    throw error;
  } finally {
    try {
      await b?.stop();
    } finally {
      await a.stop();
      await Deno.remove(dir, { recursive: true });
    }
  }
});
