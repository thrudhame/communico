// tests/federation-keychange.test.ts — key-material changes decided BEFORE
// persisting: same-id-new-bytes, a new key beside a copied old one,
// accept/warn/block policies, accept installing the candidate, forget
// resetting to first contact. Stub transport.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { serverDb, withDb } from '#engine/db.ts';
import { setConfigForTests } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  acceptKeyChange,
  acquireKeyDocWith,
  forgetServerKeys,
  getVerifyKeyWith,
  type KeysDeps,
  listKeyChanges,
} from '#engine/federation/keys.ts';
import { makeDoc, makeServer, seedServer } from './federation/doc-helper.ts';
import { resetFederationTables } from './util.ts';

function directOnly(doc: unknown, counter?: { calls: number }): KeysDeps {
  return {
    directGet: () => {
      if (counter !== undefined) counter.calls++;
      return Promise.resolve(doc);
    },
    witnessQuery: () => Promise.reject(new Error('no witnesses')),
    listWitnesses: () => Promise.resolve([]),
  };
}

// seeded docs are valid for 24h; this horizon forces a re-fetch past the cache
const FAR = Date.now() + 25 * 3600 * 1000;

async function changeRows(name: string) {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT status, acknowledged_old, candidate_json FROM server_key_changes WHERE server_name = $1 ORDER BY seen_ms;',
      [name],
    );
    return r.rows.map((row: unknown) => row as Record<string, unknown>);
  });
}

async function rememberedKeys(name: string): Promise<string[]> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT key_id FROM server_keys WHERE server_name = $1 ORDER BY key_id;',
      [name],
    );
    return r.rows.map((row: unknown) =>
      String((row as Record<string, unknown>).key_id)
    );
  });
}

Deno.test('same id, new bytes is a change (accept policy: stored + noted)', async () => {
  await resetFederationTables();
  setConfigForTests({ federation: { keychange: 'accept' } });
  const s = await makeServer('kc1.test');
  await seedServer(s);
  const rotated = await makeDoc(s, { kp: (await makeServer('x.test')).kp });
  await acquireKeyDocWith(s.name, FAR, directOnly(rotated));
  const changes = await changeRows(s.name);
  assertEquals(changes.length, 1);
  assertEquals(String(changes[0].status), 'noted');
  assertEquals(Boolean(changes[0].acknowledged_old), false);
  setConfigForTests({ federation: { keychange: 'warn' } });
});

Deno.test('a new key beside a copied old key is a change with acknowledged_old = true', async () => {
  await resetFederationTables();
  const s = await makeServer('kc2.test');
  const original = await seedServer(s);
  const oldEntry = original.verify_keys[s.keyId];
  const rotated = await makeDoc(s, {
    kp: (await makeServer('y.test')).kp,
    keyId: 'ed25519:2',
    extraVerifyKeys: { [s.keyId]: oldEntry.key },
  });
  await acquireKeyDocWith(s.name, FAR, directOnly(rotated));
  const changes = await changeRows(s.name);
  assertEquals(changes.length, 1);
  assertEquals(Boolean(changes[0].acknowledged_old), true);
});

Deno.test('warn policy: stored + noted + warns once per (name, material)', async () => {
  await resetFederationTables();
  setConfigForTests({ federation: { keychange: 'warn' } });
  const s = await makeServer('kc3.test');
  await seedServer(s);
  const rotated = await makeDoc(s, { kp: (await makeServer('z.test')).kp });
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
  try {
    await acquireKeyDocWith(s.name, FAR, directOnly(rotated));
    // second sighting of the same material does not warn again
    await acquireKeyDocWith(s.name, FAR, directOnly(rotated));
  } finally {
    console.warn = origWarn;
  }
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes(s.name));
  const changes = await changeRows(s.name);
  assertEquals(changes.length, 1);
  assertEquals(String(changes[0].status), 'noted');
});

Deno.test('block policy: remembered keys and docs untouched; candidate only in the change row; 403', async () => {
  await resetFederationTables();
  setConfigForTests({ federation: { keychange: 'block' } });
  const s = await makeServer('kc4.test');
  const original = await seedServer(s);
  const rotated = await makeDoc(s, { kp: (await makeServer('w.test')).kp });
  const err = await acquireKeyDocWith(s.name, FAR, directOnly(rotated)).catch((
    e,
  ) => e);
  assert(err instanceof MatrixError);
  assertEquals((err as MatrixError).status, 403);
  // remembered state is still the original
  const rows = await rememberedKeys(s.name);
  assertEquals(rows, [s.keyId]);
  const docRow = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT key_json FROM server_key_docs WHERE server_name = $1;',
      [s.name],
    );
    return JSON.parse(String((r.rows[0] as Record<string, unknown>).key_json));
  });
  assertEquals(docRow.valid_until_ts, original.valid_until_ts);
  // the candidate lives only inside the change row
  const changes = await changeRows(s.name);
  assertEquals(changes.length, 1);
  assertEquals(String(changes[0].status), 'blocking');
  const candidate = JSON.parse(String(changes[0].candidate_json));
  assertEquals(candidate.doc.valid_until_ts, rotated.valid_until_ts);
  setConfigForTests({ federation: { keychange: 'warn' } });
});

Deno.test('federation-key accept installs the reviewed candidate; forget resets to first contact', async () => {
  await resetFederationTables();
  setConfigForTests({ federation: { keychange: 'block' } });
  const s = await makeServer('kc5.test');
  await seedServer(s);
  const rotated = await makeDoc(s, { kp: (await makeServer('v.test')).kp });
  await acquireKeyDocWith(s.name, FAR, directOnly(rotated)).catch(() => {});
  // accept installs the candidate → the new material verifies
  // (the blocking 403 itself is the admission gate's job — commit 5)
  const ok = await acceptKeyChange(s.name);
  assertEquals(ok, true);
  const after = await getVerifyKeyWith(
    s.name,
    s.keyId,
    Date.now(),
    'request',
    directOnly(rotated),
  );
  assert(after instanceof CryptoKey);
  const changes = await listKeyChanges(s.name);
  assert(changes.some((ch) => ch.status === 'accepted'));
  // a second accept finds nothing blocking
  assertEquals(await acceptKeyChange(s.name), false);
  // forget → first contact again (no change recorded on re-acquire)
  await forgetServerKeys(s.name);
  const counter = { calls: 0 };
  await acquireKeyDocWith(s.name, FAR, directOnly(rotated, counter));
  assertEquals(counter.calls, 1);
  const afterForget = (await listKeyChanges(s.name)).filter((ch) =>
    ch.status === 'noted' || ch.status === 'blocking'
  );
  assertEquals(afterForget.length, 0);
  setConfigForTests({ federation: { keychange: 'warn' } });
});

Deno.test('a pure key drop (strict subset) is NOT a change', async () => {
  await resetFederationTables();
  const s = await makeServer('kc6.test');
  const extra = await makeServer('extra.test');
  const { exportPublicKeyRaw, b64encodeStd } = await import(
    '#engine/signing-primitives.js'
  );
  const two = await makeDoc(s, {
    extraVerifyKeys: {
      'ed25519:2': b64encodeStd(await exportPublicKeyRaw(extra.kp.publicKey)),
    },
  });
  await seedServer(s, two);
  // the new document carries only the original key — a drop, not a change
  const one = await makeDoc(s);
  await acquireKeyDocWith(s.name, FAR, directOnly(one));
  const changes = await changeRows(s.name);
  assertEquals(changes.length, 0);
});

Deno.test('block 403 is not remembered as a fetch failure (immediate retry still 403s, no dial)', async () => {
  await resetFederationTables();
  setConfigForTests({ federation: { keychange: 'block' } });
  const s = await makeServer('kc7.test');
  await seedServer(s);
  const rotated = await makeDoc(s, { kp: (await makeServer('u.test')).kp });
  const counter = { calls: 0 };
  await assertRejects(() =>
    acquireKeyDocWith(s.name, FAR, directOnly(rotated, counter))
  );
  await assertRejects(() =>
    acquireKeyDocWith(s.name, FAR, directOnly(rotated, counter))
  );
  assertEquals(counter.calls, 2); // each attempt dials — no failure memory for 403
  setConfigForTests({ federation: { keychange: 'warn' } });
});
