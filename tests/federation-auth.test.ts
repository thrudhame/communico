// tests/federation-auth.test.ts — inbound X-Matrix verification at the
// function the stage-5 endpoints call: a valid signature passes (and
// returns the origin), missing/garbage/bad → 401, wrong destination →
// 401, absent destination accepted (verified against ours), sig and
// signature names, two Authorization headers, unknown-origin key → 401,
// blocked → 403, closed-mode → 403 + pending, blocking key change → 403,
// the open-mode knock is recorded only after verification, the contact
// hook fires. (doltgres tests/federation-auth.test.ts, restored at the
// function — HTTP routing is stage 5.)
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from '@std/assert';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { setConfigForTests } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { authenticateRequest } from '#engine/federation/auth.ts';
import {
  type RequestEvidence,
  verifyRequestEvidence,
} from '#engine/federation/request-evidence.ts';
import { keyStore } from '#engine/federation/keys.ts';
import {
  addBlock,
  addPeer,
  listPending,
  removeBlock,
} from '#engine/federation/peers.ts';
import { serverSchema } from '#engine/server/schema.ts';
import {
  b32encode,
  exportPublicKeyRaw,
  signJson,
} from '#engine/signing-primitives.js';
import { openStore, type Store } from '#engine/store/index.ts';
import { directOnly, makeDoc, makeServer } from './federation/doc-helper.ts';

const OURS = 'our.test';
const TARGET = '/_matrix/federation/v1/send/txn-1?x=1';

Deno.test('authenticated admission can retain the exact request and verifying key evidence before contact side effects', async () => {
  await withStore(async (store) => {
    const origin = await makeServer('proof-origin.test');
    const server = await store.server();
    const keys = keyStore(server, { deps: directOnly(await makeDoc(origin)) });
    const bodyText = '{ "pdus": [], "edus": [] }';
    const authorization = await headerFor(origin, 'PUT', TARGET, { bodyText });
    let evidence!: RequestEvidence;
    const order: string[] = [];
    const deps = {
      server,
      keys,
      onVerified: (value: RequestEvidence) => {
        evidence = value;
        order.push('verified');
        return Promise.resolve();
      },
      onContact: () => order.push('contact'),
    };
    assertEquals(
      await authenticateRequest(deps, OURS, {
        method: 'PUT',
        uri: TARGET,
        authorization,
        body: new TextEncoder().encode(bodyText),
      }),
      origin.name,
    );
    assert(
      evidence !== undefined,
      'the durable ingress owner needs original signature evidence, not an asserted origin',
    );
    assertEquals(order, ['verified', 'contact']);
    const retained = await verifyRequestEvidence(
      JSON.parse(JSON.stringify(evidence)),
      OURS,
    );
    assertEquals(retained.request.uri, TARGET);
    assertEquals(retained.request.authorization, authorization);
    assertEquals(new TextDecoder().decode(retained.request.body), bodyText);
    assert(evidence.acquisition !== null);
    assert(evidence.acquisition.fetched <= evidence.admitted);
    assert(evidence.acquisition.until >= evidence.admitted);
    const clock = Date.now;
    try {
      Date.now = () => evidence.acquisition!.until + 86400000;
      assertEquals(
        (await verifyRequestEvidence(evidence, OURS)).evidence.admitted,
        evidence.admitted,
      );
    } finally {
      Date.now = clock;
    }
    const changes: ((copy: RequestEvidence) => void)[] = [
      (p) => {
        p.origin = 'forged.test';
      },
      (p) => {
        p.destination = 'elsewhere.test';
      },
      (p) => {
        p.admitted = p.acquisition!.until + 1;
      },
      (p) => {
        p.acquisition!.until = p.acquisition!.fetched + 8 * 86400000;
      },
      (p) => {
        p.request.uri = TARGET + '&tampered=true';
      },
      (p) => {
        p.request.method = 'POST';
      },
      (p) => {
        p.request.body = 'e30=';
      },
      (p) => {
        p.request.authorization = 'X-Matrix origin="forged.test"';
      },
      (p) => {
        p.acquisition!.doc.signatures = {};
      },
    ];
    for (const change of changes) {
      const copy = structuredClone(evidence);
      change(copy);
      await assertRejects(() => verifyRequestEvidence(copy, OURS));
    }
  });
});

Deno.test('admission evidence staging failure prevents contact side effects', async () => {
  await withStore(async (store) => {
    const origin = await makeServer('failed-proof.test');
    const server = await store.server();
    const keys = keyStore(server, { deps: directOnly(await makeDoc(origin)) });
    const fault = new Error('durable admission unavailable');
    let contacts = 0;
    assertStrictEquals(
      await assertRejects(async () =>
        authenticateRequest(
          {
            server,
            keys,
            onVerified: () => Promise.reject(fault),
            onContact: () => {
              contacts++;
            },
          },
          OURS,
          {
            method: 'PUT',
            uri: TARGET,
            authorization: await headerFor(origin, 'PUT', TARGET),
            body: new Uint8Array(),
          },
        )
      ),
      fault,
    );
    assertEquals(contacts, 0);
  });
});

Deno.test('admission evidence preserves valid padded key documents and large original bodies', async () => {
  await withStore(async (store) => {
    const origin = await makeServer('padded-proof.test');
    const doc = await makeDoc(origin);
    doc.verify_keys[origin.keyId].key += '=';
    await signJson(doc, origin.name, origin.keyId, origin.kp.privateKey);
    const server = await store.server();
    const keys = keyStore(server, { deps: directOnly(doc) });
    const bodyText = JSON.stringify({
      pdus: [],
      edus: [],
      extension: 'x'.repeat(1024 * 1024),
    });
    let proof!: RequestEvidence;
    await authenticateRequest(
      {
        server,
        keys,
        onVerified: (value) => {
          proof = value;
          return Promise.resolve();
        },
      },
      OURS,
      {
        method: 'PUT',
        uri: TARGET,
        authorization: await headerFor(origin, 'PUT', TARGET, { bodyText }),
        body: new TextEncoder().encode(bodyText),
      },
    );
    assertEquals(
      new TextDecoder().decode(
        (await verifyRequestEvidence(proof, OURS)).request.body,
      ),
      bodyText,
    );
    assertEquals(
      proof.acquisition!.doc,
      doc,
      'retain the signed origin document, do not normalize its signed fields',
    );
  });
});

Deno.test('key-is-name admission evidence is verified from the name with no invented origin document', async () => {
  await withStore(async (store) => {
    const origin = await makeServer('unused.test', 'ed25519:0');
    origin.name = b32encode(await exportPublicKeyRaw(origin.kp.publicKey))
      .toLowerCase().replace(/=+$/, '');
    const server = await store.server();
    const keys = keyStore(server, {
      deps: {
        directGet: () => {
          throw new Error('must not fetch a key name');
        },
        witnessQuery: () => {
          throw new Error('must not ask a witness');
        },
        listWitnesses: () => Promise.resolve([]),
      },
    });
    let proof!: RequestEvidence;
    await authenticateRequest(
      {
        server,
        keys,
        onVerified: (value) => {
          proof = value;
          return Promise.resolve();
        },
      },
      OURS,
      {
        method: 'PUT',
        uri: TARGET,
        authorization: await headerFor(origin, 'PUT', TARGET),
        body: new Uint8Array(),
      },
    );
    assertEquals(proof.acquisition, null);
    assertEquals(
      (await verifyRequestEvidence(proof, OURS)).evidence.origin,
      origin.name,
    );
  });
});

Deno.test('key fault ownership: request authentication preserves local key lookup faults', async () => {
  await withStore(async (store) => {
    const origin = await makeServer('local-origin.test');
    const fault = new Error('local signing cache fault');
    const server = await store.server();
    const deps = directOnly(await makeDoc(origin));
    deps.directGet = () => {
      throw fault;
    };
    const keys = keyStore(server, { deps });
    const authorization = await headerFor(origin, 'PUT', TARGET);
    assertStrictEquals(
      await assertRejects(() =>
        authenticateRequest({ server, keys }, OURS, {
          method: 'PUT',
          uri: TARGET,
          authorization,
          body: new Uint8Array(),
        })
      ),
      fault,
    );
  });
});

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
        directGet: () =>
          Promise.reject(
            new UpstreamError('transport', {
              phase: 'test',
              reason: 'unreachable',
            }),
          ),
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

Deno.test('auth: parallel authenticated requests all commit one origin door-log count', async () => {
  await withStore(async (store) => {
    const origin = await makeServer('parallel.test');
    const server = await store.server();
    const keys = keyStore(server, { deps: directOnly(await makeDoc(origin)) });
    // Prime the key cache, so the concurrent writes below are the door log.
    await keys.getVerifyKey(origin.name, origin.keyId, Date.now(), 'request');
    const authorization = await headerFor(origin, 'PUT', TARGET);
    const count = 32;
    const contacts: string[] = [];
    const results = await Promise.allSettled(
      Array.from({ length: count }, () =>
        authenticateRequest(
          {
            server,
            keys,
            onContact: (o) => contacts.push(o),
          },
          OURS,
          {
            method: 'PUT',
            uri: TARGET,
            authorization,
            body: new Uint8Array(),
          },
        )),
    );
    assertEquals(results.map((r) => r.status), Array(count).fill('fulfilled'));
    assertEquals(
      results.map((r) => r.status === 'fulfilled' ? r.value : null),
      Array(count).fill(origin.name),
    );
    const rows = await listPending(server);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].name, origin.name);
    assertEquals(rows[0].verified, true);
    assertEquals(rows[0].count, count);
    assertEquals(contacts, Array(count).fill(origin.name));
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

Deno.test('auth: malformed signature candidates cannot mask a later valid candidate', async () => {
  await withStore(async (store) => {
    const origin = await makeServer('origin.test');
    const good = await headerFor(origin, 'PUT', TARGET);
    const bad =
      `X-Matrix origin="${origin.name}",key="${origin.keyId}",sig="%"`;
    assertEquals(await attempt(store, origin, bad), '401');
    assertEquals(
      await attempt(store, origin, bad + ',' + good),
      'ok:origin.test',
    );
  });
});

Deno.test('auth: invalid signed JSON and canonical numbers fail as authentication input', async () => {
  await withStore(async (store) => {
    const origin = await makeServer('origin.test');
    const auth = await headerFor(origin, 'PUT', TARGET);
    for (
      const bodyText of ['{', '{"n":1.5}', '{"n":9007199254740992}', '{"n":-0}']
    ) {
      const contacts: string[] = [];
      assertEquals(
        await attempt(store, origin, auth, { bodyText, contacts }),
        '401',
      );
      assertEquals(contacts, []);
      assertEquals(await listPending(await store.server()), []);
    }
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
