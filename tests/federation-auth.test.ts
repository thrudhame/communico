// tests/federation-auth.test.ts — inbound X-Matrix verification at the
// function the stage-5 endpoints call: a valid signature passes (and
// returns the origin), missing/garbage/bad → 401, wrong destination →
// 401, absent destination accepted (verified against ours), sig and
// signature names, two Authorization headers, unknown-origin key → 401,
// blocked → 403, closed-mode → 403 + pending, blocking key change → 403,
// the open-mode knock is recorded only after verification, the contact
// hook fires. (doltgres tests/federation-auth.test.ts, restored at the
// function — HTTP routing is stage 5.)
import { assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { authenticateRequest } from '#engine/federation/auth.ts';
import { keyStore } from '#engine/federation/keys.ts';
import {
  addBlock,
  addPeer,
  listPending,
  removeBlock,
} from '#engine/federation/peers.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { signJson } from '#engine/signing-primitives.js';
import { openStore, type Store } from '#engine/store/index.ts';
import { directOnly, makeDoc, makeServer } from './federation/doc-helper.ts';

const OURS = 'our.test';
const TARGET = '/_matrix/federation/v1/send/txn-1?x=1';

type Origin = Awaited<ReturnType<typeof makeServer>>;

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

async function headerFor(
  origin: Origin,
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
    origin: origin.name,
  };
  // the rebuild ALWAYS carries destination: ours — the signed object must
  // too (destination: null means "no header PARAM", the signed JSON still
  // includes ours)
  const dest = opts.destination !== undefined && opts.destination !== null
    ? opts.destination
    : OURS;
  obj.destination = dest;
  if (opts.bodyText !== undefined) {
    obj.content = JSON.parse(opts.bodyText);
  }
  const signed = await signJson(
    obj,
    origin.name,
    origin.keyId,
    origin.kp.privateKey,
  );
  const signatures = signed.signatures as Record<
    string,
    Record<string, string>
  >;
  const sig = signatures[origin.name][origin.keyId];
  const destPart = opts.destination !== undefined && opts.destination !== null
    ? `,destination="${opts.destination}"`
    : '';
  const name = opts.param !== undefined && opts.param === 'signature'
    ? 'signature'
    : 'sig';
  return `X-Matrix origin="${origin.name}"${destPart},key="${origin.keyId}",${name}="${sig}"`;
}

// Call authenticateRequest and collapse the outcome to a status-ish
// string for the refusal matrix; the verified origin comes back on 'ok'.
async function attempt(
  store: Store,
  origin: Origin,
  authorization: string | null,
  opts: {
    method?: string;
    uri?: string;
    bodyText?: string;
    contacts?: string[];
    unreachable?: boolean;
  } = {},
): Promise<string> {
  const server = await store.server();
  const keys = keyStore(server, {
    deps: opts.unreachable === true
      ? {
        directGet: () => Promise.reject(new Error('unreachable')),
        witnessQuery: () => Promise.reject(new Error('no witnesses')),
        listWitnesses: () => Promise.resolve([]),
      }
      : directOnly(await makeDoc(origin)),
  });
  try {
    const verified = await authenticateRequest(
      {
        server,
        keys,
        onContact: (o) => {
          if (opts.contacts !== undefined) opts.contacts.push(o);
        },
      },
      OURS,
      {
        method: opts.method !== undefined ? opts.method : 'PUT',
        uri: opts.uri !== undefined ? opts.uri : TARGET,
        authorization,
        body: new TextEncoder().encode(
          opts.bodyText !== undefined ? opts.bodyText : '',
        ),
      },
    );
    return 'ok:' + verified;
  } catch (e) {
    if (e instanceof MatrixError) return `${(e as MatrixError).status}`;
    throw e;
  }
}

Deno.test('auth: a valid signature passes and returns the origin; the contact hook fires', async () => {
  await withStore(async (store) => {
    const origin = await makeServer('origin.test');
    const contacts: string[] = [];
    const auth = await headerFor(origin, 'PUT', TARGET);
    assertEquals(
      await attempt(store, origin, auth, { contacts }),
      'ok:origin.test',
    );
    assertEquals(contacts, ['origin.test']);
  });
});

Deno.test('auth: missing header → 401; garbage scheme → 401', async () => {
  await withStore(async (store) => {
    const origin = await makeServer('origin.test');
    assertEquals(await attempt(store, origin, null), '401');
    assertEquals(await attempt(store, origin, 'Bearer xyz'), '401');
  });
});

Deno.test('auth: bad signature → 401', async () => {
  await withStore(async (store) => {
    const origin = await makeServer('origin.test');
    const good = await headerFor(origin, 'PUT', TARGET);
    // corrupt a character INSIDE the quoted sig value
    const sigStart = good.lastIndexOf('sig="') + 5;
    const bad = good.slice(0, sigStart) +
      (good[sigStart] === 'A' ? 'B' : 'A') +
      good.slice(sigStart + 1);
    assertEquals(await attempt(store, origin, bad), '401');
  });
});

Deno.test('auth: a destination that is not us → 401', async () => {
  await withStore(async (store) => {
    const origin = await makeServer('origin.test');
    const auth = await headerFor(origin, 'PUT', TARGET, {
      destination: 'else.test',
    });
    assertEquals(await attempt(store, origin, auth), '401');
  });
});

Deno.test('auth: absent destination is accepted and verified against ours', async () => {
  await withStore(async (store) => {
    const origin = await makeServer('origin.test');
    const auth = await headerFor(origin, 'PUT', TARGET, { destination: null });
    assertEquals(await attempt(store, origin, auth), 'ok:origin.test');
  });
});

Deno.test('auth: the signature= parameter name is accepted', async () => {
  await withStore(async (store) => {
    const origin = await makeServer('origin.test');
    const auth = await headerFor(origin, 'PUT', TARGET, { param: 'signature' });
    assertEquals(await attempt(store, origin, auth), 'ok:origin.test');
  });
});

Deno.test('auth: two Authorization headers — one valid is enough', async () => {
  await withStore(async (store) => {
    const origin = await makeServer('origin.test');
    const good = await headerFor(origin, 'PUT', TARGET);
    const bad = 'X-Matrix origin="nope.test",key="ed25519:1",sig="AAAA"';
    assertEquals(
      await attempt(store, origin, `${bad},${good}`),
      'ok:origin.test',
    );
  });
});

Deno.test('auth: the signed body is covered — a tampered body → 401', async () => {
  await withStore(async (store) => {
    const origin = await makeServer('origin.test');
    const bodyText = JSON.stringify({ origin: 'origin.test', pdus: [] });
    const auth = await headerFor(origin, 'PUT', TARGET, { bodyText });
    assertEquals(
      await attempt(store, origin, auth, { method: 'PUT', bodyText }),
      'ok:origin.test',
    );
    assertEquals(
      await attempt(store, origin, auth, {
        method: 'PUT',
        bodyText: JSON.stringify({ origin: 'origin.test', pdus: ['x'] }),
      }),
      '401',
    );
  });
});

Deno.test('auth: unknown origin whose key cannot be fetched → 401', async () => {
  await withStore(async (store) => {
    const origin = await makeServer('origin.test');
    const auth =
      'X-Matrix origin="unreachable.example",key="ed25519:1",sig="AAAA"';
    assertEquals(
      await attempt(store, origin, auth, { unreachable: true }),
      '401',
    );
  });
});

Deno.test('auth: blocked origin → 403', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    const origin = await makeServer('origin.test');
    await addBlock(server, origin.name, 'roster-less block');
    const auth = await headerFor(origin, 'PUT', TARGET);
    assertEquals(await attempt(store, origin, auth), '403');
    await removeBlock(server, origin.name);
  });
});

Deno.test('auth: closed mode + unknown origin → 403 and a pending claim', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    setConfigForTests({ federation: { mode: 'closed' } });
    try {
      const origin = await makeServer('origin.test');
      const auth = await headerFor(origin, 'PUT', TARGET);
      assertEquals(await attempt(store, origin, auth), '403');
      const rows = await listPending(server);
      assertEquals(rows[0].name, origin.name);
      assertEquals(rows[0].kind, 'inbound');
      assertEquals(rows[0].verified, false);
    } finally {
      setConfigForTests({ federation: { mode: 'open' } });
    }
  });
});

Deno.test('auth: a blocking key change → 403', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    const origin = await makeServer('origin.test');
    await server.execute(
      "INSERT INTO server_key_changes(server_name, seen_ms, old_keys, new_keys, status, acknowledged_old) VALUES(?, 1, '{}', '{}', 'blocking', 0)",
      [origin.name],
    );
    const auth = await headerFor(origin, 'PUT', TARGET);
    assertEquals(await attempt(store, origin, auth), '403');
  });
});

Deno.test('auth: open-mode first contact is recorded only after verification; a rostered peer records nothing', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    const origin = await makeServer('origin.test');
    const auth = await headerFor(origin, 'PUT', TARGET);
    assertEquals(await attempt(store, origin, auth), 'ok:origin.test');
    const rows = await listPending(server);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].name, origin.name);
    assertEquals(rows[0].verified, true);
    // a rostered peer: no knock to record
    await addPeer(server, {
      name: origin.name,
      host: null,
      port: null,
      trust: 'ca',
      addedBy: 'operator',
    });
    const again = await headerFor(origin, 'PUT', TARGET);
    assertEquals(await attempt(store, origin, again), 'ok:origin.test');
    assertEquals((await listPending(server)).length, 0);
  });
});
