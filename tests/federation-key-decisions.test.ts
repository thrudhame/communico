import { assert, assertEquals, assertRejects } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { canonicalJson } from '#engine/canonical.ts';
import {
  exportKeyDecisions,
  KEY_DECISIONS_SQL,
} from '#engine/federation/key-decisions.ts';
import { keyStore, reconcileKeyDecisions } from '#engine/federation/keys.ts';
import { admit } from '#engine/federation/gate.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import {
  directOnly,
  makeDoc,
  makeServer,
  seedServer,
} from './federation/doc-helper.ts';

async function fixture() {
  setConfigForTests({ federation: { keychange: 'block' } });
  const dir = await Deno.makeTempDir();
  const open = (name: string) =>
    openStore({
      dir: dir + '/' + name,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema } });
  const home = await open('home'), edge = await open('edge');
  const source = await home.server(), replica = await edge.server();
  const remote = await makeServer('decisions.test');
  await seedServer(source, remote);
  await seedServer(replica, remote);
  const doc = await makeDoc(remote, {
    keyId: 'ed25519:new',
    kp: (await makeServer('rotated.test')).kp,
  });
  const horizon = Date.now() + 25 * 3600000;
  const admin = keyStore(source, { deps: directOnly(doc) });
  await assertRejects(() => admin.acquireKeyDoc(remote.name, horizon));
  assert(await admin.acceptKeyChange(remote.name));
  return {
    source,
    replica,
    admin,
    remote,
    doc,
    horizon,
    decisions: () => exportKeyDecisions(source),
    async apply() {
      return await reconcileKeyDecisions(
        replica,
        await exportKeyDecisions(source),
        (install) => replica.tx(install),
      );
    },
    async close() {
      await Promise.all([home.close(), edge.close()]);
      await Deno.remove(dir, { recursive: true });
      setConfigForTests({});
    },
  };
}

Deno.test('key decision replay neither renews the source validity floor nor overwrites a newer local acquisition', async () => {
  const f = await fixture();
  try {
    const decisions = await f.decisions();
    const approved = decisions[0];
    assert(approved.action === 'accept');
    // A remotely advertised long lifetime still uses the source acquisition cut.
    const sourceRows = await f.source.query(
      'SELECT valid_until_ts,fetched_ms FROM server_keys WHERE server_name=?',
      [f.remote.name],
    );
    await f.apply();
    assertEquals(
      await f.replica.query(
        'SELECT valid_until_ts,fetched_ms FROM server_keys WHERE server_name=?',
        [f.remote.name],
      ),
      sourceRows,
    );
    // A valid renewal with identical material may be acquired independently.
    await f.replica.execute(
      "UPDATE server_key_docs SET via='independent-renewal' WHERE server_name=?",
      [f.remote.name],
    );
    await f.apply();
    assertEquals(
      (await f.replica.query(
        'SELECT via FROM server_key_docs WHERE server_name=?',
        [f.remote.name],
      ))[0].via,
      'independent-renewal',
    );
    const changed = structuredClone(decisions);
    assert(changed[0].action === 'accept');
    changed[0].acquired++;
    await assertRejects(
      () =>
        reconcileKeyDecisions(
          f.replica,
          changed,
          (install) => f.replica.tx(install),
        ),
      Error,
      'decision diverged',
    );
    const invalid = structuredClone(decisions);
    assert(invalid[0].action === 'accept');
    invalid[0].doc.signatures = {};
    await assertRejects(
      () =>
        reconcileKeyDecisions(
          f.replica,
          invalid,
          (install) => f.replica.tx(install),
        ),
      Error,
      'invalid self signature',
    );
  } finally {
    await f.close();
  }
});

Deno.test('home approval clears matching material only, preserving a different local candidate for the same peer', async () => {
  const f = await fixture();
  try {
    const different = await makeDoc(f.remote, {
      keyId: 'ed25519:other',
      kp: (await makeServer('other.test')).kp,
    });
    const keys = keyStore(f.replica, { deps: directOnly(different) });
    await assertRejects(() => keys.acquireKeyDoc(f.remote.name, f.horizon));
    await f.apply();
    await assertRejects(() =>
      admit(f.replica, f.remote.name, { kind: 'lookup', what: 'review' })
    );
    const changes = await keys.listKeyChanges(f.remote.name);
    assert(changes.some((c) => c.status === 'blocking'));
    assertEquals(
      canonicalJson(JSON.parse(changes[0].new_keys)),
      canonicalJson(
        Object.fromEntries(
          Object.entries(different.verify_keys).map((
            [id, entry],
          ) => [id, entry.key]),
        ),
      ),
    );
  } finally {
    await f.close();
  }
});

Deno.test('replicated key decisions roll back with their caller and fence obsolete acquisition on commit', async () => {
  const f = await fixture();
  try {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<unknown>();
    const keys = keyStore(f.replica, {
      deps: {
        ...directOnly(f.doc),
        directGet: () => {
          entered.resolve();
          return release.promise;
        },
      },
    });
    const pending = keys.acquireKeyDoc(f.remote.name, f.horizon).then(
      () => null,
      (error: unknown) => error,
    );
    await entered.promise;
    const decisions = await f.decisions();
    await assertRejects(
      () =>
        reconcileKeyDecisions(
          f.replica,
          decisions,
          (install) =>
            f.replica.tx(async (conn) => {
              await install(conn);
              throw new Error('simulated journal commit failure');
            }),
        ),
      Error,
      'simulated journal commit failure',
    );
    assertEquals(await exportKeyDecisions(f.replica), []);
    assertEquals(
      (await keys.listServerKeys(f.remote.name))[0].rows[0].key_id,
      f.remote.keyId,
    );
    await f.apply();
    release.resolve(f.doc);
    const failure = await pending;
    assert(failure instanceof Error && failure.message.includes('superseded'));
    await keys.getVerifyKey(
      f.remote.name,
      'ed25519:new',
      Date.now(),
      'request',
    );
    await f.admin.forgetServerKeys(f.remote.name);
    await f.apply();
    assertEquals((await keys.listServerKeys(f.remote.name))[0], {
      rows: [],
      doc: null,
    });
    const forgotten = await exportKeyDecisions(f.replica);
    assertEquals(forgotten[0].action, 'forget');
    assertEquals(forgotten[0].revision, 2);
  } finally {
    await f.close();
  }
});

Deno.test('key decision migration preserves already-reviewed signed documents and their acquisition cut', async () => {
  const f = await fixture();
  try {
    const before = await f.decisions();
    await f.source.tx(async (conn) => {
      await conn.execute('DROP TABLE server_key_decisions');
      await conn.exec(KEY_DECISIONS_SQL);
    }, { mode: 'deferred' });
    assertEquals(await f.decisions(), before);
    assertEquals(
      await exportKeyDecisions(f.replica),
      [],
      'ordinary cache entries are not operator decisions',
    );
  } finally {
    await f.close();
  }
});
