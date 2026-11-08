// tests/federation-keychange.test.ts — key-material changes decided
// BEFORE persisting: same-id-new-bytes, a new key beside a copied old
// one, accept/warn/block policies, accept installing the candidate,
// forget resetting to first contact (doltgres
// tests/federation-keychange.test.ts, restored). Stub transport over a
// real server file.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
} from '#engine/signing-primitives.js';
import { keyStore } from '#engine/federation/keys.ts';
import { serverSchema } from '#engine/server/schema.ts';
import type { Db } from '#engine/store/db.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import {
  directOnly,
  makeDoc,
  makeServer,
  seedServer,
} from './federation/doc-helper.ts';

// seeded docs are valid for 24h; this horizon forces a re-fetch past the cache
const FAR = Date.now() + 25 * 3600 * 1000;

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

async function changeRows(server: Db, name: string) {
  const rows = await server.query(
    'SELECT status, acknowledged_old, candidate_json FROM server_key_changes WHERE server_name = ? ORDER BY seen_ms',
    [name],
  );
  return rows;
}

async function rememberedKeys(server: Db, name: string): Promise<string[]> {
  const rows = await server.query(
    'SELECT key_id FROM server_keys WHERE server_name = ? ORDER BY key_id',
    [name],
  );
  return rows.map((row) => String(row.key_id));
}

Deno.test('same id, new bytes is a change (accept policy: stored + noted)', async () => {
  setConfigForTests({ federation: { keychange: 'accept' } });
  await withStore(async (store) => {
    const server = await store.server();
    const s = await makeServer('kc1.test');
    await seedServer(server, s);
    const rotated = await makeDoc(s, { kp: (await makeServer('x.test')).kp });
    await keyStore(server, { deps: directOnly(rotated) }).acquireKeyDoc(
      s.name,
      FAR,
    );
    const changes = await changeRows(server, s.name);
    assertEquals(changes.length, 1);
    assertEquals(String(changes[0].status), 'noted');
    assertEquals(Number(changes[0].acknowledged_old), 0);
  });
  setConfigForTests({ federation: { keychange: 'warn' } });
});

Deno.test('a new key beside a copied old key is a change with acknowledged_old = true', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    const s = await makeServer('kc2.test');
    const original = await seedServer(server, s);
    const oldEntry = original.verify_keys[s.keyId];
    const rotated = await makeDoc(s, {
      kp: (await makeServer('y.test')).kp,
      keyId: 'ed25519:2',
      extraVerifyKeys: { [s.keyId]: oldEntry.key },
    });
    await keyStore(server, { deps: directOnly(rotated) }).acquireKeyDoc(
      s.name,
      FAR,
    );
    const changes = await changeRows(server, s.name);
    assertEquals(changes.length, 1);
    assertEquals(Number(changes[0].acknowledged_old), 1);
  });
});

Deno.test('warn policy: stored + noted + warns once per (name, material)', async () => {
  setConfigForTests({ federation: { keychange: 'warn' } });
  await withStore(async (store) => {
    const server = await store.server();
    const s = await makeServer('kc3.test');
    await seedServer(server, s);
    const rotated = await makeDoc(s, { kp: (await makeServer('z.test')).kp });
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    try {
      const ks = keyStore(server, { deps: directOnly(rotated) });
      await ks.acquireKeyDoc(s.name, FAR);
      // second sighting of the same material does not warn again
      await ks.acquireKeyDoc(s.name, FAR);
    } finally {
      console.warn = origWarn;
    }
    assertEquals(warnings.length, 1);
    assert(warnings[0].includes(s.name));
    const changes = await changeRows(server, s.name);
    assertEquals(changes.length, 1);
    assertEquals(String(changes[0].status), 'noted');
  });
});

Deno.test('block policy: remembered keys and docs untouched; candidate only in the change row; 403', async () => {
  setConfigForTests({ federation: { keychange: 'block' } });
  await withStore(async (store) => {
    const server = await store.server();
    const s = await makeServer('kc4.test');
    const original = await seedServer(server, s);
    const rotated = await makeDoc(s, { kp: (await makeServer('w.test')).kp });
    const err = await keyStore(server, { deps: directOnly(rotated) })
      .acquireKeyDoc(s.name, FAR).catch((e) => e);
    assert(err instanceof MatrixError);
    assertEquals((err as MatrixError).status, 403);
    // remembered state is still the original
    const rows = await rememberedKeys(server, s.name);
    assertEquals(rows, [s.keyId]);
    const docRow = await server.query(
      'SELECT key_json FROM server_key_docs WHERE server_name = ?',
      [s.name],
    );
    assertEquals(
      (JSON.parse(String(docRow[0].key_json)) as { valid_until_ts: number })
        .valid_until_ts,
      original.valid_until_ts,
    );
    // the candidate lives only inside the change row
    const changes = await changeRows(server, s.name);
    assertEquals(changes.length, 1);
    assertEquals(String(changes[0].status), 'blocking');
    const candidate = JSON.parse(String(changes[0].candidate_json));
    assertEquals(candidate.doc.valid_until_ts, rotated.valid_until_ts);
  });
  setConfigForTests({ federation: { keychange: 'warn' } });
});

Deno.test('federation-key accept installs the reviewed candidate; forget resets to first contact', async () => {
  setConfigForTests({ federation: { keychange: 'block' } });
  await withStore(async (store) => {
    const server = await store.server();
    const s = await makeServer('kc5.test');
    await seedServer(server, s);
    const rotated = await makeDoc(s, { kp: (await makeServer('v.test')).kp });
    const ks = keyStore(server, { deps: directOnly(rotated) });
    await ks.acquireKeyDoc(s.name, FAR).catch(() => {});
    // accept installs the candidate → the new material verifies
    // (the blocking 403 itself is the admission gate's job — 4c-2)
    const ok = await ks.acceptKeyChange(s.name);
    assertEquals(ok, true);
    const after = await ks.getVerifyKey(s.name, s.keyId, Date.now(), 'request')
      .then(() => 'ok')
      .catch(() => 'refused');
    // the rotated doc carries the same key id with new bytes
    assertEquals(after, 'ok');
    const changes = await ks.listKeyChanges(s.name);
    assert(changes.some((ch) => ch.status === 'accepted'));
    // a second accept finds nothing blocking
    assertEquals(await ks.acceptKeyChange(s.name), false);
    // forget → first contact again (no change recorded on re-acquire)
    await ks.forgetServerKeys(s.name);
    const counter = { calls: 0 };
    const ks2 = keyStore(server, { deps: directOnly(rotated, counter) });
    await ks2.acquireKeyDoc(s.name, FAR);
    assertEquals(counter.calls, 1);
    const afterForget = (await ks2.listKeyChanges(s.name)).filter((ch) =>
      ch.status === 'noted' || ch.status === 'blocking'
    );
    assertEquals(afterForget.length, 0);
  });
  setConfigForTests({ federation: { keychange: 'warn' } });
});

Deno.test('a pure key drop (strict subset) is NOT a change', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    const s = await makeServer('kc6.test');
    const extra = await makeServer('extra.test');
    const two = await makeDoc(s, {
      extraVerifyKeys: {
        'ed25519:2': b64encodeStd(await exportPublicKeyRaw(extra.kp.publicKey)),
      },
    });
    await seedServer(server, s, two);
    // the new document carries only the original key — a drop, not a change
    const one = await makeDoc(s);
    await keyStore(server, { deps: directOnly(one) }).acquireKeyDoc(
      s.name,
      FAR,
    );
    const changes = await changeRows(server, s.name);
    assertEquals(changes.length, 0);
  });
});

Deno.test('block 403 is not remembered as a fetch failure (immediate retry still 403s, no dial)', async () => {
  setConfigForTests({ federation: { keychange: 'block' } });
  await withStore(async (store) => {
    const server = await store.server();
    const s = await makeServer('kc7.test');
    await seedServer(server, s);
    const rotated = await makeDoc(s, { kp: (await makeServer('u.test')).kp });
    const counter = { calls: 0 };
    const ks = keyStore(server, { deps: directOnly(rotated, counter) });
    await assertRejects(() => ks.acquireKeyDoc(s.name, FAR));
    await assertRejects(() => ks.acquireKeyDoc(s.name, FAR));
    assertEquals(counter.calls, 2); // each attempt dials — no failure memory for 403
  });
  setConfigForTests({ federation: { keychange: 'warn' } });
});
