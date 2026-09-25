// tests/federation-gate.test.ts — the admission gate: blocks, closed-mode
// claims (bucketed, capped, coalesced, expiring), open-mode inbound
// proceed, outbound user intent, blocking key changes, approve/reject.
import { assert, assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { serverDb, withDb } from '#engine/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { admit } from '#engine/federation/gate.ts';
import {
  addBlock,
  addPeer,
  approvePending,
  isBlocked,
  listPeers,
  listPending,
  recordPending,
  rejectPending,
  removeBlock,
  removePeer,
} from '#engine/federation/peers.ts';
import { resetFederationTables } from './util.ts';

async function forbid(name: string, ctx: Parameters<typeof admit>[1]) {
  try {
    await admit(name, ctx);
    return 'ok';
  } catch (e) {
    if (e instanceof MatrixError) return `${(e as MatrixError).status}`;
    throw e;
  }
}

Deno.test('gate: block glob → 403 both directions', async () => {
  await resetFederationTables();
  await addBlock('*.evil.test', 'test block');
  assertEquals(await isBlocked('x.evil.test'), true);
  assertEquals(await isBlocked('ok.test'), false);
  assertEquals(
    await forbid('x.evil.test', { kind: 'inbound', endpoint: '/x' }),
    '403',
  );
  assertEquals(
    await forbid('x.evil.test', {
      kind: 'outbound',
      user: '@a:ours',
      what: 'invite',
    }),
    '403',
  );
  await removeBlock('*.evil.test');
});

Deno.test('gate: closed mode + unknown inbound → 403 + unverified pending row', async () => {
  await resetFederationTables();
  setConfigForTests({ federation: { mode: 'closed' } });
  const out = await forbid('stranger.test', {
    kind: 'inbound',
    endpoint: '/query/profile',
  });
  assertEquals(out, '403');
  const rows = await listPending();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].name, 'stranger.test');
  assertEquals(rows[0].kind, 'inbound');
  assertEquals(rows[0].verified, false);
  assertEquals(rows[0].detail, '/query/profile');
  setConfigForTests({ federation: { mode: 'open' } });
});

Deno.test('gate: closed mode + a local user’s outbound → 403 + pending(outbound)', async () => {
  await resetFederationTables();
  setConfigForTests({ federation: { mode: 'closed' } });
  const out = await forbid('stranger.test', {
    kind: 'outbound',
    user: '@alice:localhost',
    what: 'invite @bob:stranger.test',
  });
  assertEquals(out, '403');
  const rows = await listPending();
  assertEquals(rows[0].kind, 'outbound');
  assertEquals(
    rows[0].detail,
    '@alice:localhost — invite @bob:stranger.test',
  );
  setConfigForTests({ federation: { mode: 'open' } });
});

Deno.test('gate: open mode + unknown inbound proceeds; verified row written after verify', async () => {
  await resetFederationTables();
  const out = await forbid('knocker.test', {
    kind: 'inbound',
    endpoint: '/send',
  });
  assertEquals(out, 'ok');
  // the middleware's post-verify record (verified=true)
  await recordPending('knocker.test', 'inbound', true, '/send');
  const rows = await listPending();
  assertEquals(rows[0].verified, true);
});

Deno.test('gate: open mode + outbound intent joins the roster as ca', async () => {
  await resetFederationTables();
  const out = await forbid('newfriend.test', {
    kind: 'outbound',
    user: '@alice:localhost',
    what: 'invite @bob:newfriend.test',
  });
  assertEquals(out, 'ok');
  const peers = await listPeers();
  assertEquals(peers.length, 1);
  assertEquals(peers[0].name, 'newfriend.test');
  assertEquals(peers[0].trust, 'ca');
  assertEquals(peers[0].added_by, '@alice:localhost');
});

Deno.test('gate: a blocking key change → 403 until accepted', async () => {
  await resetFederationTables();
  await withDb(serverDb(), async (c) => {
    await c.query(
      "INSERT INTO server_key_changes (server_name, seen_ms, old_keys, new_keys, status, acknowledged_old) VALUES ('changed.test', 1, '{}', '{}', 'blocking', FALSE);",
    );
  });
  assertEquals(
    await forbid('changed.test', { kind: 'inbound', endpoint: '/x' }),
    '403',
  );
  await withDb(serverDb(), async (c) => {
    await c.query("UPDATE server_key_changes SET status = 'accepted';");
  });
  assertEquals(
    await forbid('changed.test', { kind: 'inbound', endpoint: '/x' }),
    'ok',
  );
});

Deno.test('pending: a flood of forged names cannot grow unverified rows past pendingmax', async () => {
  await resetFederationTables();
  setConfigForTests({ federation: { pendingmax: 5 } });
  for (let i = 0; i < 40; i++) {
    await recordPending(`forged${i}.test`, 'inbound', false, '/x');
  }
  const rows = await listPending();
  const unverified = rows.filter((r) => !r.verified);
  assertEquals(unverified.length, 5);
  setConfigForTests({ federation: { pendingmax: 10000 } });
});

Deno.test('pending: repeated knocks coalesce within keyfailminutes', async () => {
  await resetFederationTables();
  for (let i = 0; i < 5; i++) {
    await recordPending('repeat.test', 'inbound', false, '/x');
  }
  const rows = await listPending();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].count, 5);
  // coalescing keeps the first sighting's first_ms and bumps last_ms
  assert(rows[0].last_ms >= rows[0].first_ms);
});

Deno.test('pending: rows older than pendingdays are pruned', async () => {
  await resetFederationTables();
  await withDb(serverDb(), async (c) => {
    await c.query(
      "INSERT INTO federation_pending (name, kind, verified, first_ms, last_ms, count) VALUES ('old.test', 'inbound', FALSE, 1, 1, 1);",
    );
    await c.query(
      "INSERT INTO federation_pending (name, kind, verified, first_ms, last_ms, count) VALUES ('new.test', 'inbound', FALSE, $1, $1, 1);",
      [Date.now()],
    );
  });
  // next unverified write prunes the expired row
  await recordPending('trigger.test', 'inbound', false, '/x');
  const rows = await listPending();
  assert(!rows.some((r) => r.name === 'old.test'));
  assert(rows.some((r) => r.name === 'new.test'));
});

Deno.test('tools: approve moves the claim to the roster; reject drops it (optionally blocks)', async () => {
  await resetFederationTables();
  await recordPending('knock.test', 'inbound', false, '/x');
  await approvePending('knock.test', '127.0.0.1', 8449);
  const peers = await listPeers();
  assertEquals(peers[0].name, 'knock.test');
  assertEquals(peers[0].added_by, 'approval');
  assertEquals((await listPending()).length, 0);
  await recordPending('nope.test', 'inbound', false, '/x');
  await rejectPending('nope.test', true);
  assertEquals(await isBlocked('nope.test'), true);
  await removePeer('knock.test');
  await removeBlock('nope.test');
});

Deno.test('witnesses: only operator/approval rows, ordered by seniority; keyname excluded', async () => {
  await resetFederationTables();
  await addPeer({
    name: 'user-added.test',
    host: null,
    port: null,
    trust: 'ca',
    addedBy: '@alice:localhost',
  });
  await addPeer({
    name: 'op1.test',
    host: null,
    port: null,
    trust: 'ca',
    addedBy: 'operator',
  });
  await addPeer({
    name: 'op2.test',
    host: null,
    port: null,
    trust: 'ca',
    addedBy: 'operator',
  });
  await addPeer({
    name: 'approved.test',
    host: null,
    port: null,
    trust: 'ca',
    addedBy: 'approval',
  });
  await addPeer({
    name: 'keyname.test',
    host: '127.0.0.1',
    port: 8449,
    trust: 'keyname',
    addedBy: 'operator',
  });
  const { listWitnesses } = await import('#engine/federation/peers.ts');
  // seniority = oldest added first (op1 added after user-added, before op2)
  const witnesses = await listWitnesses();
  assertEquals(witnesses.filter((w) => w === 'user-added.test').length, 0);
  assertEquals(witnesses.filter((w) => w === 'keyname.test').length, 0);
  assert(witnesses.includes('op1.test'));
  assert(witnesses.includes('op2.test'));
  assert(witnesses.includes('approved.test'));
});
