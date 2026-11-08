// Restore the old middleware assertions at the real HTTP boundary.
import { assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { serverName, setConfigForTests } from '#engine/config.ts';
import { keyStore } from '#engine/federation/keys.ts';
import {
  addBlock,
  listPending,
  removeBlock,
} from '#engine/federation/peers.ts';
import { signJson } from '#engine/signing-primitives.js';
import { httpSuite } from './http-app.ts';
import { directOnly, makeDoc, makeServer } from './federation/doc-helper.ts';

const { matrix, test } = httpSuite('HTTP X-Matrix middleware');
const target = '/_matrix/federation/v1/query/nope?user_id=%40alice%3Alocalhost';
type Origin = Awaited<ReturnType<typeof makeServer>>;
let origin: Origin;

async function header(
  options: { destination?: string | null; param?: string; body?: unknown } = {},
) {
  const signed = await signJson(
    {
      method: options.body === undefined ? 'GET' : 'POST',
      uri: target,
      origin: origin.name,
      destination: options.destination ?? serverName(),
      ...(options.body === undefined ? {} : { content: options.body }),
    },
    origin.name,
    origin.keyId,
    origin.kp.privateKey,
  );
  const sigs = signed.signatures as Record<string, Record<string, string>>;
  const destination = options.destination === null
    ? ''
    : `,destination="${options.destination ?? serverName()}"`;
  return `X-Matrix origin="${origin.name}"${destination},key="${origin.keyId}",${
    options.param ?? 'sig'
  }="${sigs[origin.name][origin.keyId]}"`;
}

async function call(authorization?: string, body?: unknown) {
  const res = await matrix(
    new Request('http://x' + target, {
      method: body === undefined ? 'GET' : 'POST',
      headers: authorization === undefined ? {} : { authorization },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  assertEquals(res.headers.get('access-control-allow-origin'), '*');
  const json = await res.json();
  return { status: res.status, code: json.errcode };
}

test('valid signature reaches protected miss, recording only verified contact', async () => {
  origin = await makeServer('origin.test');
  const keys = keyStore(theApp().server, {
    deps: directOnly(await makeDoc(origin)),
  });
  await keys.acquireKeyDoc(origin.name, Date.now());
  assertEquals(await call(await header()), {
    status: 404,
    code: 'M_UNRECOGNIZED',
  });
  const pending = await listPending(theApp().server);
  assertEquals(pending.length, 1);
  assertEquals(pending[0].verified, true);
});

test('missing/garbage headers and bad signature are 401', async () => {
  for (const auth of [undefined, 'Bearer xyz']) {
    assertEquals(await call(auth), { status: 401, code: 'M_UNAUTHORIZED' });
  }
  const good = await header();
  const at = good.lastIndexOf('sig="') + 5;
  const bad = good.slice(0, at) + (good[at] === 'A' ? 'B' : 'A') +
    good.slice(at + 1);
  assertEquals(await call(bad), { status: 401, code: 'M_UNAUTHORIZED' });
});

test('wrong destination refused, absent destination and signature spelling accepted', async () => {
  assertEquals(await call(await header({ destination: 'else.test' })), {
    status: 401,
    code: 'M_UNAUTHORIZED',
  });
  for (const options of [{ destination: null }, { param: 'signature' }]) {
    assertEquals(await call(await header(options)), {
      status: 404,
      code: 'M_UNRECOGNIZED',
    });
  }
});

test('multiple candidates, unknown origin and exact raw URI', async () => {
  const bad = 'X-Matrix origin="localhost:1",key="ed25519:1",sig="AAAA"';
  assertEquals(await call(bad + ',' + await header()), {
    status: 404,
    code: 'M_UNRECOGNIZED',
  });
  assertEquals(await call(bad), { status: 401, code: 'M_UNAUTHORIZED' });
});

test('body bytes survive JSON middleware, tampering is refused', async () => {
  const body = { origin: origin.name, pdus: [] };
  const auth = await header({ body });
  assertEquals(await call(auth, body), {
    status: 404,
    code: 'M_UNRECOGNIZED',
  });
  assertEquals(await call(auth, { ...body, pdus: ['tampered'] }), {
    status: 401,
    code: 'M_UNAUTHORIZED',
  });
});

test('blocked, closed unknown and blocking key change are 403', async () => {
  const db = theApp().server;
  await addBlock(db, origin.name, 'test');
  assertEquals(await call(await header()), {
    status: 403,
    code: 'M_FORBIDDEN',
  });
  await removeBlock(db, origin.name);
  setConfigForTests({ federation: { mode: 'closed' } });
  try {
    assertEquals(await call(await header()), {
      status: 403,
      code: 'M_FORBIDDEN',
    });
    const pending = await listPending(db);
    assertEquals(pending[0].kind, 'inbound');
  } finally {
    setConfigForTests({});
  }
  await db.execute(
    "INSERT INTO server_key_changes(server_name, seen_ms, old_keys, new_keys, status, acknowledged_old) VALUES(?,1,'{}','{}','blocking',0)",
    [origin.name],
  );
  assertEquals(await call(await header()), {
    status: 403,
    code: 'M_FORBIDDEN',
  });
});
