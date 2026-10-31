// tests/federation-gate.test.ts — the admission gate (4c-2): blocks both
// directions, closed-mode claims (bucketed), open-mode inbound proceeds,
// outbound user intent joins the roster as 'ca', blocking key changes,
// the approve/reject tool doors. (The gate half of doltgres
// tests/federation-gate.test.ts, restored; the roster/pending half is
// 4c-1's federation-peers.test.ts.)
import { assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  admit,
  approvePending,
  rejectPending,
} from '#engine/federation/gate.ts';
import {
  addBlock,
  isBlocked,
  listPeers,
  listPending,
  recordPending,
  removeBlock,
  removePeer,
} from '#engine/federation/peers.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore, type Store } from '#engine/store/index.ts';

async function withStore(
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(
    {
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    },
    { schemas: { server: serverSchema } },
  );
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function forbid(
  store: Store,
  name: string,
  ctx: Parameters<typeof admit>[2],
): Promise<string> {
  const server = await store.server();
  try {
    await admit(server, name, ctx);
    return 'ok';
  } catch (e) {
    if (e instanceof MatrixError) return `${(e as MatrixError).status}`;
    throw e;
  }
}

Deno.test('gate: block glob → 403 both directions', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    await addBlock(server, '*.evil.test', 'test block');
    assertEquals(await isBlocked(server, 'x.evil.test'), true);
    assertEquals(await isBlocked(server, 'ok.test'), false);
    assertEquals(
      await forbid(store, 'x.evil.test', { kind: 'inbound', endpoint: '/x' }),
      '403',
    );
    assertEquals(
      await forbid(store, 'x.evil.test', {
        kind: 'outbound',
        user: '@a:ours',
        what: 'invite',
      }),
      '403',
    );
    await removeBlock(server, '*.evil.test');
  });
});

Deno.test('gate: closed mode + unknown inbound → 403 + unverified pending row', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    setConfigForTests({ federation: { mode: 'closed' } });
    try {
      const out = await forbid(store, 'stranger.test', {
        kind: 'inbound',
        endpoint: '/query/profile',
      });
      assertEquals(out, '403');
      const rows = await listPending(server);
      assertEquals(rows.length, 1);
      assertEquals(rows[0].name, 'stranger.test');
      assertEquals(rows[0].kind, 'inbound');
      assertEquals(rows[0].verified, false);
      assertEquals(rows[0].detail, '/query/profile');
    } finally {
      setConfigForTests({ federation: { mode: 'open' } });
    }
  });
});

Deno.test('gate: closed mode + a local user’s outbound → 403 + pending(outbound)', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    setConfigForTests({ federation: { mode: 'closed' } });
    try {
      const out = await forbid(store, 'stranger.test', {
        kind: 'outbound',
        user: '@alice:localhost',
        what: 'invite @bob:stranger.test',
      });
      assertEquals(out, '403');
      const rows = await listPending(server);
      assertEquals(rows[0].kind, 'outbound');
      assertEquals(
        rows[0].detail,
        '@alice:localhost — invite @bob:stranger.test',
      );
    } finally {
      setConfigForTests({ federation: { mode: 'open' } });
    }
  });
});

Deno.test('gate: open mode + unknown inbound proceeds', async () => {
  await withStore(async (store) => {
    assertEquals(
      await forbid(store, 'knocker.test', {
        kind: 'inbound',
        endpoint: '/send',
      }),
      'ok',
    );
  });
});

Deno.test('gate: open mode + outbound intent joins the roster as ca', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    const out = await forbid(store, 'newfriend.test', {
      kind: 'outbound',
      user: '@alice:localhost',
      what: 'invite @bob:newfriend.test',
    });
    assertEquals(out, 'ok');
    const peers = await listPeers(server);
    assertEquals(peers.length, 1);
    assertEquals(peers[0].name, 'newfriend.test');
    assertEquals(peers[0].trust, 'ca');
    assertEquals(peers[0].added_by, '@alice:localhost');
    await removePeer(server, 'newfriend.test');
  });
});

Deno.test('gate: a blocking key change → 403 until accepted', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    await server.execute(
      "INSERT INTO server_key_changes(server_name, seen_ms, old_keys, new_keys, status, acknowledged_old) VALUES('changed.test', 1, '{}', '{}', 'blocking', 0)",
      [],
    );
    assertEquals(
      await forbid(store, 'changed.test', { kind: 'inbound', endpoint: '/x' }),
      '403',
    );
    await server.execute(
      "UPDATE server_key_changes SET status = 'accepted'",
      [],
    );
    assertEquals(
      await forbid(store, 'changed.test', { kind: 'inbound', endpoint: '/x' }),
      'ok',
    );
  });
});

Deno.test('tools: approve moves the claim to the roster; reject drops it (optionally blocks)', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    await recordPending(server, 'knock.test', 'inbound', false, '/x');
    await approvePending(server, 'knock.test', '127.0.0.1', 8449);
    const peers = await listPeers(server);
    assertEquals(peers[0].name, 'knock.test');
    assertEquals(peers[0].added_by, 'approval');
    assertEquals(peers[0].host, '127.0.0.1');
    assertEquals(peers[0].port, 8449);
    assertEquals((await listPending(server)).length, 0);
    await recordPending(server, 'nope.test', 'inbound', false, '/x');
    await rejectPending(server, 'nope.test', true);
    assertEquals(await isBlocked(server, 'nope.test'), true);
    assertEquals((await listPending(server)).length, 0);
    await removePeer(server, 'knock.test');
    await removeBlock(server, 'nope.test');
  });
});

Deno.test('tools: a refused row is a delivery record, not a knock — approve refuses it', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    await recordPending(server, 'refused.test', 'refused', true, '{}');
    let status = 0;
    try {
      await approvePending(server, 'refused.test', null, null);
    } catch (e) {
      status = (e as MatrixError).status;
    }
    assertEquals(status, 400);
    assertEquals((await listPeers(server)).length, 0);
  });
});
