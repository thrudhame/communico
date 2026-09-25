// tests/federation-auth.test.ts — the X-Matrix middleware: valid request
// passes (404 — handlers land in a later commit), missing/bad signature
// 401, wrong destination 401, absent destination accepted, sig/signature
// names, two Authorization headers, unknown-origin key 401, blocked 403,
// closed-mode 403 + pending, blocking key change 403.
import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { serverDb, withDb } from '#engine/db.ts';
import { serverName, setConfigForTests } from '#engine/config.ts';
import {
  addBlock,
  listPending,
  removeBlock,
} from '#engine/federation/peers.ts';
import { wireFederationTransport } from '#engine/federation/client.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { type FakeServer, startFakeServer } from './federation/fake-server.ts';
import { resetFederationTables } from './util.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

async function inProcessKeyDoc(): Promise<unknown> {
  const res = await matrix(
    new Request('http://x/_matrix/key/v2/server'),
  );
  return await res.json();
}

const TARGET = '/_matrix/federation/v1/query/profile?user_id=@alice:localhost';
// the middleware passed ⇒ the handler answers (@alice is seeded by db-init)
const AUTH_PASSED = 200;

function withFixtureCa(): void {
  setConfigForTests({
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  resetCaCertsForTests();
}

function clearFixtureCa(): void {
  setConfigForTests({ federation: { cacerts: [] } });
  resetCaCertsForTests();
}

async function headerFor(
  fake: FakeServer,
  method: string,
  target: string,
  opts: {
    destination?: string | null;
    bodyText?: string;
    param?: 'sig' | 'signature';
  } = {},
): Promise<string> {
  const obj: Record<string, unknown> = {
    method,
    uri: target,
    origin: fake.name,
  };
  // the middleware's rebuild ALWAYS carries destination: ours — the
  // signed object must too (destination: null means "no header PARAM",
  // the signed JSON still includes ours)
  const dest = opts.destination !== undefined && opts.destination !== null
    ? opts.destination
    : serverName();
  obj.destination = dest;
  if (opts.bodyText !== undefined) {
    obj.content = JSON.parse(opts.bodyText);
  }
  const signed = await fake.sign(obj);
  const signatures = signed.signatures as Record<
    string,
    Record<string, string>
  >;
  const sig = signatures[fake.name][fake.keyId];
  const destPart = opts.destination !== undefined && opts.destination !== null
    ? `,destination="${opts.destination}"`
    : '';
  const name = opts.param !== undefined && opts.param === 'signature'
    ? 'signature'
    : 'sig';
  return `X-Matrix origin="${fake.name}"${destPart},key="${fake.keyId}",${name}="${sig}"`;
}

async function withFake<T>(fn: (fake: FakeServer) => Promise<T>): Promise<T> {
  wireFederationTransport();
  const fake = await startFakeServer({
    ourKeyDoc: inProcessKeyDoc,
  });
  try {
    return await fn(fake);
  } finally {
    await fake.close();
  }
}

function get(
  target: string,
  headers: Record<string, string>,
): Promise<Response> {
  return matrix(new Request('http://x' + target, { headers }));
}

Deno.test('auth: a valid signature passes the middleware (404 until the handler lands)', async () => {
  wireFederationTransport();
  await resetFederationTables();
  withFixtureCa();
  await withFake(async (fake) => {
    const auth = await headerFor(fake, 'GET', TARGET);
    const res = await get(TARGET, { Authorization: auth });
    assertEquals(res.status, AUTH_PASSED);
  });
  clearFixtureCa();
});

Deno.test('auth: missing header → 401; garbage scheme → 401', async () => {
  await withFake(async () => {
    const none = await get(TARGET, {});
    assertEquals(none.status, 401);
    const garbage = await get(TARGET, { Authorization: 'Bearer xyz' });
    assertEquals(garbage.status, 401);
  });
});

Deno.test('auth: bad signature → 401', async () => {
  await withFake(async (fake) => {
    const good = await headerFor(fake, 'GET', TARGET);
    // corrupt a character INSIDE the quoted sig value
    const sigStart = good.lastIndexOf('sig="') + 5;
    const bad = good.slice(0, sigStart) +
      (good[sigStart] === 'A' ? 'B' : 'A') +
      good.slice(sigStart + 1);
    const res = await get(TARGET, { Authorization: bad });
    assertEquals(res.status, 401);
  });
});

Deno.test('auth: a destination that is not us → 401', async () => {
  await withFake(async (fake) => {
    const auth = await headerFor(fake, 'GET', TARGET, {
      destination: 'else.test',
    });
    const res = await get(TARGET, { Authorization: auth });
    assertEquals(res.status, 401);
  });
});

Deno.test('auth: absent destination is accepted and verified against ours', async () => {
  withFixtureCa();
  await withFake(async (fake) => {
    const auth = await headerFor(fake, 'GET', TARGET, { destination: null });
    const res = await get(TARGET, { Authorization: auth });
    assertEquals(res.status, AUTH_PASSED);
  });
  clearFixtureCa();
});

Deno.test('auth: the signature= parameter name is accepted', async () => {
  withFixtureCa();
  await withFake(async (fake) => {
    const auth = await headerFor(fake, 'GET', TARGET, { param: 'signature' });
    const res = await get(TARGET, { Authorization: auth });
    assertEquals(res.status, AUTH_PASSED);
  });
  clearFixtureCa();
});

Deno.test('auth: two Authorization headers — one valid is enough', async () => {
  withFixtureCa();
  await withFake(async (fake) => {
    const good = await headerFor(fake, 'GET', TARGET);
    const bad = 'X-Matrix origin="nope.test",key="ed25519:1",sig="AAAA"';
    const headers = new Headers();
    headers.append('authorization', bad);
    headers.append('authorization', good);
    const res = await matrix(
      new Request('http://x' + TARGET, { headers }),
    );
    assertEquals(res.status, AUTH_PASSED);
  });
  clearFixtureCa();
});

Deno.test('auth: unknown origin whose key cannot be fetched → 401', async () => {
  await resetFederationTables();
  await withFake(async () => {
    const auth =
      'X-Matrix origin="unreachable.example",key="ed25519:1",sig="AAAA"';
    const res = await get(TARGET, { Authorization: auth });
    assertEquals(res.status, 401);
  });
});

Deno.test('auth: blocked origin → 403', async () => {
  await resetFederationTables();
  await withFake(async (fake) => {
    await addBlock(fake.name, 'roster-less block');
    const auth = await headerFor(fake, 'GET', TARGET);
    const res = await get(TARGET, { Authorization: auth });
    assertEquals(res.status, 403);
    await removeBlock(fake.name);
  });
});

Deno.test('auth: closed mode + unknown origin → 403 and a pending claim', async () => {
  await resetFederationTables();
  setConfigForTests({ federation: { mode: 'closed' } });
  await withFake(async (fake) => {
    const auth = await headerFor(fake, 'GET', TARGET);
    const res = await get(TARGET, { Authorization: auth });
    assertEquals(res.status, 403);
    const rows = await listPending();
    assertEquals(rows[0].name, fake.name);
    assertEquals(rows[0].kind, 'inbound');
    assertEquals(rows[0].verified, false);
  });
  setConfigForTests({ federation: { mode: 'open' } });
});

Deno.test('auth: a blocking key change → 403', async () => {
  await resetFederationTables();
  await withFake(async (fake) => {
    await withDb(serverDb(), async (c) => {
      await c.query(
        'INSERT INTO server_key_changes (server_name, seen_ms, old_keys, new_keys, status, acknowledged_old) VALUES ($1, 1, $2, $3, $4, FALSE);',
        [fake.name, '{}', '{}', 'blocking'],
      );
    });
    const auth = await headerFor(fake, 'GET', TARGET);
    const res = await get(TARGET, { Authorization: auth });
    assertEquals(res.status, 403);
  });
});

Deno.test('auth: open-mode first contact is recorded only after verification', async () => {
  await resetFederationTables();
  wireFederationTransport();
  withFixtureCa();
  await withFake(async (fake) => {
    const auth = await headerFor(fake, 'GET', TARGET);
    const res = await get(TARGET, { Authorization: auth });
    assertEquals(res.status, AUTH_PASSED);
    const rows = await listPending();
    assertEquals(rows.length, 1);
    assertEquals(rows[0].verified, true);
  });
  clearFixtureCa();
});

Deno.test('auth: body memoization — body.bytes() re-reads after the json middleware', async () => {
  wireFederationTransport();
  await resetFederationTables();
  withFixtureCa();
  await withFake(async (fake) => {
    // pin for the middleware's body re-read (pathfinder 0.2.2 memoized
    // bytes() — the 0.2.4 bump must keep it)
    const target =
      '/_matrix/federation/v1/query/profile?user_id=%40alice%3Alocalhost';
    const auth = await headerFor(fake, 'GET', target);
    const res = await get(target, { Authorization: auth });
    assertEquals(res.status, AUTH_PASSED);
  });
  clearFixtureCa();
});
