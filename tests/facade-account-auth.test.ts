import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import {
  AccountSnapshots,
  exportAccountAuth,
  exportSessionAuthority,
  startAccountExports,
} from '#engine/facade/accounts.ts';
import { enrolledTenant, initializeNode } from '#engine/facade/identity.ts';
import { Journal } from '#engine/facade/journal.ts';
import { exportOwnerControl, OwnerControls } from '#engine/facade/ownership.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { JournalReconciler } from '#engine/facade/worker.ts';
import {
  LINK_CAPABILITIES,
  LINK_SUPPORTED,
  LinkError,
} from '#engine/facade/protocol.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  type AccountAuth,
  installAccountAuth,
  requireAccountAuth,
} from '#engine/tenant/account-auth.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  deactivateUser,
  loginUser,
  registerUser,
  verifyUserPassword,
} from '#engine/tenant/users.ts';
import {
  hashToken,
  lookupToken,
  revokeAllTokens,
} from '#engine/tenant/auth.ts';
import { captureSessionAuthority } from '#engine/tenant/session-authority.ts';
import { deleteDevices } from '#engine/tenant/devices.ts';
import { bounded } from './helpers/server-process.ts';
import { AuthLinkHealth, FacadeAuth } from '#engine/facade/auth.ts';
import { consumeRefreshToken } from '#engine/tenant/auth.ts';
import { PASSWORD_FLOWS, requireUia, uiaAction } from '#engine/tenant/uia.ts';
import { historicalTenantSchema } from './fixtures/tenant-schema-history.ts';

Deno.test('auth publication migration upgrades tenant27 without inventing a publication for older snapshots', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'auth-publication-upgrade-' });
  const config = (name: string) => ({
    dir: dir + '/' + name,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  let old = await openStore(config('old'), {
    schemas: { tenant: historicalTenantSchema(27) },
  });
  const fresh = await openStore(config('fresh'), {
    schemas: { tenant: tenantSchema },
  });
  try {
    const tenant = await openTenant(old, 'logical.test', { create: true });
    await registerUser(tenant, {
      localpart: 'alice',
      password: 'pw',
      accessToken: null,
    });
    const publicKey = tenant.publicB64;
    const db = await old.tenant('logical.test');
    await db.execute(
      'INSERT INTO account_auth_snapshots(localpart,pairing,grant_revision,owner_revision,source_cut,revision,material_hash,captured_ms,checked_ms,credentials) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ['alice', 'pair', 1, 1, 7, 1, 'a'.repeat(64), 1, 1, 1],
    );
    const snapshots = await db.query('SELECT * FROM account_auth_snapshots');
    await old.close();
    old = await openStore(config('old'), { schemas: { tenant: tenantSchema } });
    await openTenant(fresh, 'logical.test', { create: true });
    const upgraded = await old.tenant('logical.test');
    const sql =
      "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
    assertEquals(
      await upgraded.query(sql),
      await (await fresh.tenant('logical.test')).query(sql),
    );
    assertEquals(
      await upgraded.query('SELECT * FROM account_auth_snapshots'),
      snapshots,
    );
    assertEquals(
      await upgraded.query('SELECT * FROM account_auth_publications'),
      [],
    );
    const reopened = await openTenant(old, 'logical.test');
    assertEquals(reopened.publicB64, publicKey);
    assertEquals(await verifyUserPassword(reopened, 'alice', 'pw'), true);
  } finally {
    await old.close();
    await fresh.close();
    await Deno.remove(dir, { recursive: true });
  }
});

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-account-auth-' });
  const open = (name: string) =>
    openStore({
      dir: dir + '/' + name,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema, tenant: tenantSchema } });
  const home = await open('home'), edge = await open('edge');
  const ht = await openTenant(home, 'logical.test', { create: true });
  await registerUser(ht, {
    localpart: 'alice',
    password: 'pw',
    accessToken: null,
  });
  const node = await initializeNode(
    await edge.server(),
    'logical.test',
    'edge_a',
  );
  const hp = new Pairings(
    await home.server(),
    ht.signer(),
    ht.publicB64,
    'a'.repeat(64),
  );
  const fp = new Pairings(
    await edge.server(),
    node.signer(),
    node.publicKey,
    'b'.repeat(64),
    node,
  );
  const bundle = await hp.create({
    node: 'edge_a',
    url: 'https://facade.test',
    facadePin: 'b'.repeat(64),
    expires: Date.now() + 60000,
    required: [...LINK_CAPABILITIES],
  });
  await fp.accept(bundle);
  await hp.confirm(
    bundle.id,
    await fp.complete(
      bundle.id,
      await hp.grant(
        bundle.id,
        await fp.challenge(bundle.id, bundle.secret, 'a'.repeat(64)),
      ),
      'a'.repeat(64),
    ),
  );
  const et = await enrolledTenant(edge, fp, 'logical.test', 'edge_a');
  const journal = new Journal(await edge.server(), LINK_SUPPORTED);
  const owners = new OwnerControls(
    await edge.server(),
    await edge.tenant('logical.test'),
    fp,
    node,
  );
  const owner = await exportOwnerControl(home, ht, hp, bundle.id);
  await journal.receive('home', [owner]);
  await owners.apply(journal, owner);
  const receiver = new AccountSnapshots(edge, et, fp, owners);
  const emit = (credentials = true) =>
    exportAccountAuth(home, ht, hp, bundle.id, 'alice', credentials);
  return {
    open,
    home,
    edge,
    ht,
    et,
    hp,
    fp,
    node,
    owners,
    bundle,
    journal,
    receiver,
    emit,
    async guarded(
      settings: {
        replicatecredentials: boolean;
        allowstaleauth: boolean;
        authmaxstalehours: number;
      },
      health = new AuthLinkHealth({ notify: 'websocket', pollseconds: 1 }),
    ) {
      const ingress = new FacadeAuth(
        await edge.server(),
        fp,
        node,
        health,
        settings,
      );
      return {
        ingress,
        health,
        tenant: await enrolledTenant(
          edge,
          fp,
          'logical.test',
          'edge_a',
          ingress,
        ),
      };
    },
    async nextOwner(install = true) {
      const body = { ...(await owners.ready()), revision: 2 };
      const signed = {
        body,
        signature: await ht.signer().sign(canonicalJson(body)),
      };
      const record = await new Journal(await home.server(), LINK_SUPPORTED)
        .append('edge_a', {
          source: 'home',
          incarnation: bundle.id,
          stream: 'owner-control',
          type: 'owner-control',
          version: 1,
          operationId: 'owner-control-revision-2',
          payload: signed,
        });
      // Simulate the home control owner's publication of its next revision.
      await (await home.server()).execute(
        'UPDATE facade_owner_activation SET revision=2 WHERE pairing=?',
        [bundle.id],
      );
      await journal.receive('home', [record]);
      if (install) await owners.apply(journal, record);
      return record;
    },
    async close() {
      await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('local auth clock observations cannot abort an imported authority commit', async () => {
  const f = await fixture();
  const release = Promise.withResolvers<void>();
  let importing: Promise<void> | undefined;
  try {
    const first = await f.emit();
    await f.journal.receive('home', [first]);
    await f.receiver.apply(f.journal, first);
    const next = await f.emit();
    const view =
      (next.payload as { signed: { body: AccountAuth } }).signed.body;
    const db = await f.edge.tenant('logical.test');
    const [original] = await db.query(
      'SELECT checked_ms FROM account_auth_snapshots WHERE localpart=?',
      ['alice'],
    );
    const binding = {
      pairing: f.bundle.id,
      grantRevision: 1,
      ownerRevision: 1,
    };
    const settings = { allowstaleauth: true, authmaxstalehours: 0 };
    const now = Math.max(Number(original.checked_ms), view.capturedMs) + 1;
    const prepared = Promise.withResolvers<void>();
    let attempts = 0;
    importing = db.tx(async (conn) => {
      attempts++;
      await installAccountAuth(conn, view);
      prepared.resolve();
      await release.promise;
    });
    // Observe a rejection before the test task releases the real writer.
    importing.catch((error) => prepared.reject(error));
    await prepared.promise;
    let admissionError: unknown;
    try {
      await db.tx((conn) =>
        requireAccountAuth(conn, 'alice', binding, settings, true, true, now)
      );
    } catch (error) {
      admissionError = error;
    } finally {
      release.resolve();
      await importing;
    }
    assertEquals(
      admissionError,
      undefined,
      'a held complete auth cut remains usable during import',
    );
    assertEquals(
      attempts,
      1,
      'local clock observation must not invalidate the imported authority writer',
    );
    const [after] = await db.query(
      'SELECT checked_ms FROM account_auth_snapshots WHERE localpart=?',
      ['alice'],
    );
    assertEquals(
      Number(after.checked_ms),
      Math.max(Number(original.checked_ms), view.capturedMs),
    );
    await assertRejects(
      () =>
        db.tx((conn) =>
          requireAccountAuth(
            conn,
            'alice',
            binding,
            settings,
            true,
            true,
            now - 1,
          )
        ),
      MatrixError,
      'authentication snapshot unavailable',
    );
    // A pre-upgrade request observation remains a floor even when it is newer
    // than the independently persisted local counter.
    await db.execute(
      'UPDATE account_auth_snapshots SET checked_ms=? WHERE localpart=?',
      [now + 2, 'alice'],
    );
    await assertRejects(
      () =>
        db.tx((conn) =>
          requireAccountAuth(
            conn,
            'alice',
            binding,
            settings,
            true,
            true,
            now + 1,
          )
        ),
      MatrixError,
      'authentication snapshot unavailable',
    );
    await f.edge.close();
    const reopened = await f.open('edge');
    try {
      const cold = await reopened.tenant('logical.test');
      await assertRejects(
        () =>
          cold.tx((conn) =>
            requireAccountAuth(
              conn,
              'alice',
              binding,
              settings,
              true,
              true,
              now - 1,
            )
          ),
        MatrixError,
        'authentication snapshot unavailable',
      );
      await cold.tx((conn) =>
        requireAccountAuth(
          conn,
          'alice',
          binding,
          settings,
          true,
          true,
          now + 2,
        )
      );
    } finally {
      await reopened.close();
    }
  } finally {
    release.resolve();
    await importing?.catch(() => {});
    await f.close();
  }
});

Deno.test('irreversible deactivation refuses login even when a captured auth cut is superseded', async () => {
  const f = await fixture();
  try {
    await deactivateUser(f.ht, 'alice');
    const first = await f.emit();
    await f.journal.receive('home', [first]);
    await f.receiver.apply(f.journal, first);
    const guarded = await f.guarded({
      replicatecredentials: true,
      allowstaleauth: true,
      authmaxstalehours: 0,
    });
    const captured = await guarded.ingress.prepare();
    const stale = await openTenant(f.edge, 'logical.test', {
      ingress: captured,
    });
    const next = await f.emit();
    await f.journal.receive('home', [next]);
    await f.receiver.apply(f.journal, next);
    const failure = await assertRejects(() =>
      loginUser(stale, {
        localpart: 'alice',
        password: 'pw',
        deviceId: 'deactivated',
        refresh: true,
      }), MatrixError);
    assertEquals(failure.status, 403);
    assertEquals(failure.errcode, 'M_FORBIDDEN');
    assertEquals(
      await (await f.edge.tenant('logical.test')).query(
        'SELECT token FROM access_tokens',
      ),
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade ingress admits only an applied bound account cut and keeps unknown bearer semantics', async () => {
  const f = await fixture();
  try {
    const guarded = await f.guarded({
      replicatecredentials: true,
      allowstaleauth: true,
      authmaxstalehours: 0,
    });
    assertEquals(await lookupToken(guarded.tenant, 'unknown'), null);
    await assertRejects(
      () => verifyUserPassword(guarded.tenant, 'alice', 'pw'),
      MatrixError,
      'authentication snapshot unavailable',
    );
    const record = await f.emit();
    await f.journal.receive('home', [record]);
    await assertRejects(
      () => verifyUserPassword(guarded.tenant, 'alice', 'pw'),
      MatrixError,
      'authentication snapshot unavailable',
    );
    await f.receiver.apply(f.journal, record);
    assertEquals(await verifyUserPassword(guarded.tenant, 'alice', 'pw'), true);
    const session = await loginUser(guarded.tenant, {
      localpart: 'alice',
      password: 'pw',
      deviceId: 'outside',
      refresh: true,
    });
    assertEquals(
      (await lookupToken(guarded.tenant, session.accessToken))?.localpart,
      'alice',
    );
    const disabled = await f.guarded({
      replicatecredentials: false,
      allowstaleauth: true,
      authmaxstalehours: 0,
    });
    assertEquals(
      (await lookupToken(disabled.tenant, session.accessToken))?.localpart,
      'alice',
    );
    await assertRejects(
      () => verifyUserPassword(disabled.tenant, 'alice', 'pw'),
      MatrixError,
      'authentication snapshot unavailable',
    );
    const limited = await f.guarded({
      replicatecredentials: true,
      allowstaleauth: true,
      authmaxstalehours: 1,
    });
    await (await f.edge.tenant('logical.test')).execute(
      'UPDATE account_auth_snapshots SET captured_ms=?',
      [Date.now() - 7200000],
    );
    await assertRejects(
      () => lookupToken(limited.tenant, session.accessToken),
      MatrixError,
      'authentication snapshot unavailable',
    );
    await assertRejects(
      () => consumeRefreshToken(limited.tenant, session.refreshToken!),
      MatrixError,
      'authentication snapshot unavailable',
    );
    assertEquals(await lookupToken(limited.tenant, 'unknown'), null);
    await (await f.edge.tenant('logical.test')).execute(
      'DELETE FROM session_authority WHERE hash=?',
      [await hashToken(session.accessToken)],
    );
    await assertRejects(
      () => lookupToken(guarded.tenant, session.accessToken),
      MatrixError,
      'authentication snapshot unavailable',
    );
  } finally {
    await f.close();
  }
});

Deno.test('strict facade ingress requires live authenticated link and its full current account head, never hello contact alone', async () => {
  const f = await fixture();
  try {
    const guarded = await f.guarded({
      replicatecredentials: true,
      allowstaleauth: false,
      authmaxstalehours: 0,
    });
    const first = await f.emit();
    await f.journal.receive('home', [first]);
    await f.receiver.apply(f.journal, first);
    const connection = new AbortController();
    guarded.health.connected(f.bundle.id, connection.signal);
    await assertRejects(
      () => verifyUserPassword(guarded.tenant, 'alice', 'pw'),
      MatrixError,
      'authentication snapshot unavailable',
    );
    const declaration = (
      record: typeof first,
    ) => [{
      source: record.source,
      incarnation: record.incarnation,
      stream: record.stream,
      head: { sequence: record.sequence, hash: record.hash },
    }];
    guarded.health.observe(f.bundle.id, declaration(first));
    assertEquals(await verifyUserPassword(guarded.tenant, 'alice', 'pw'), true);
    const second = await f.emit();
    guarded.health.observe(f.bundle.id, declaration(second));
    // An older concurrent page may arrive late, but cannot lower the target.
    guarded.health.observe(f.bundle.id, declaration(first));
    await assertRejects(
      () => verifyUserPassword(guarded.tenant, 'alice', 'pw'),
      MatrixError,
      'authentication snapshot unavailable',
    );
    await f.journal.receive('home', [second]);
    await assertRejects(
      () => verifyUserPassword(guarded.tenant, 'alice', 'pw'),
      MatrixError,
      'authentication snapshot unavailable',
    );
    await f.receiver.apply(f.journal, second);
    assertEquals(await verifyUserPassword(guarded.tenant, 'alice', 'pw'), true);
    connection.abort();
    await assertRejects(
      () => verifyUserPassword(guarded.tenant, 'alice', 'pw'),
      MatrixError,
      'authentication snapshot unavailable',
    );
    const replacement = new AbortController();
    guarded.health.connected(f.bundle.id, replacement.signal);
    await assertRejects(
      () => verifyUserPassword(guarded.tenant, 'alice', 'pw'),
      MatrixError,
      'authentication snapshot unavailable',
    );
    guarded.health.observe(f.bundle.id, declaration(second));
    assertEquals(await verifyUserPassword(guarded.tenant, 'alice', 'pw'), true);
    replacement.abort();
  } finally {
    await f.close();
  }
});

Deno.test('auth admission reads one committed publication across preparation and journal completion', async (t) => {
  for (const completion of [false, true]) {
    await t.step(
      completion ? 'after journal completion' : 'before journal completion',
      async () => {
        const f = await fixture();
        const release = Promise.withResolvers<void>();
        let applying: Promise<boolean> | undefined;
        try {
          await loginUser(f.ht, {
            localpart: 'alice',
            password: 'pw',
            deviceId: 'home-target',
            refresh: false,
          });
          const first = await f.emit();
          await f.journal.receive('home', [first]);
          await f.receiver.apply(f.journal, first);
          const guarded = await f.guarded({
            replicatecredentials: true,
            allowstaleauth: true,
            authmaxstalehours: 0,
          });
          const session = await loginUser(guarded.tenant, {
            localpart: 'alice',
            password: 'pw',
            deviceId: 'edge-caller',
            refresh: false,
          });
          const prepared = await guarded.ingress.prepare();
          const held = await enrolledTenant(
            f.edge,
            f.fp,
            'logical.test',
            'edge_a',
            prepared,
          );
          const strict = await f.guarded({
            replicatecredentials: true,
            allowstaleauth: false,
            authmaxstalehours: 0,
          });
          const connection = new AbortController();
          strict.health.connected(f.bundle.id, connection.signal);
          const declare = (record: typeof first) => [{
            source: record.source,
            incarnation: record.incarnation,
            stream: record.stream,
            head: { sequence: record.sequence, hash: record.hash },
          }];
          strict.health.observe(f.bundle.id, declare(first));
          const strictPrepared = await strict.ingress.prepare();
          const strictHeld = await enrolledTenant(
            f.edge,
            f.fp,
            'logical.test',
            'edge_a',
            strictPrepared,
          );
          const next = await f.emit();
          await f.journal.receive('home', [next]);
          const committed = Promise.withResolvers<void>();
          const journal = new Proxy(f.journal, {
            get(target, key) {
              if (key === 'apply') {
                return async (...args: Parameters<Journal['apply']>) => {
                  committed.resolve();
                  await release.promise;
                  return await target.apply(...args);
                };
              }
              const value = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          applying = f.receiver.apply(journal, next);
          applying.catch((error) => committed.reject(error));
          await committed.promise;
          if (completion) {
            release.resolve();
            await applying;
          }
          // This is a real verified owner commit, not a fabricated newer counter.
          assertEquals(
            (await lookupToken(held, session.accessToken))?.device_id,
            'edge-caller',
          );
          assertEquals(await verifyUserPassword(held, 'alice', 'pw'), true);
          const authorization = await requireUia(held, {
            caller: '@alice:logical.test',
            token: session.accessToken,
            flows: PASSWORD_FLOWS,
            action: uiaAction('delete-device', ['home-target']),
            targets: ['home-target'],
            body: { auth: { type: 'm.login.password', password: 'pw' } },
          });
          await deleteDevices(held, 'alice', ['home-target'], authorization);
          assertEquals(
            await held.tx((tx) => tx.devices.exists('home-target', 'alice')),
            false,
          );
          assertEquals(
            (await lookupToken(held, session.accessToken))?.device_id,
            'edge-caller',
          );
          await assertRejects(
            () => lookupToken(strictHeld, session.accessToken),
            MatrixError,
            'authentication snapshot unavailable',
          );
          if (!completion) {
            await assertRejects(
              () => lookupToken(strict.tenant, session.accessToken),
              MatrixError,
              'authentication snapshot unavailable',
            );
            release.resolve();
            await applying;
          }
          strict.health.observe(f.bundle.id, declare(next));
          assertEquals(
            (await lookupToken(strict.tenant, session.accessToken))?.localpart,
            'alice',
          );
          connection.abort();
          await revokeAllTokens(f.ht, 'alice');
          const revoked = await f.emit();
          await f.journal.receive('home', [revoked]);
          await f.receiver.apply(f.journal, revoked);
          const refusal = await assertRejects(
            () => lookupToken(held, session.accessToken),
            MatrixError,
            'session authority revoked',
          );
          assertEquals(refusal.status, 401);
        } finally {
          release.resolve();
          await applying?.catch(() => {});
          await f.close();
        }
      },
    );
  }
});

Deno.test('auth snapshot owner installs only the newest received authority before completing its superseded prefix', async () => {
  const f = await fixture();
  try {
    const first = await f.emit();
    await f.journal.receive('home', [first]);
    await f.receiver.apply(f.journal, first);
    const older = [await f.emit(), await f.emit()];
    await deactivateUser(f.ht, 'alice');
    const latest = await f.emit();
    await f.journal.receive('home', [...older, latest]);
    const db = await f.edge.tenant('logical.test');
    const installs: number[] = [];
    const receiver = new AccountSnapshots(
      new Proxy(f.edge, {
        get(store, key) {
          if (key === 'tenant') {
            return () =>
              Promise.resolve({
                ...db,
                tx: <T>(callback: Parameters<typeof db.tx<T>>[0]) =>
                  db.tx(async (conn) => {
                    const execute = conn.execute.bind(conn);
                    conn.execute = (sql, values = []) => {
                      if (
                        sql.startsWith('INSERT INTO account_auth_snapshots(')
                      ) installs.push(Number(values[4]));
                      return execute(sql, values);
                    };
                    return await callback(conn);
                  }),
              });
          }
          const value = Reflect.get(store, key);
          return typeof value === 'function' ? value.bind(store) : value;
        },
      }),
      f.et,
      f.fp,
      f.owners,
    );
    assertEquals(await receiver.apply(f.journal, latest), true);
    const body =
      (latest.payload as { signed: { body: AccountAuth } }).signed.body;
    assertEquals(installs, [body.sourceCut]);
    assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), false);
    assertEquals(
      (await f.journal.heads('home', 'in', latest)).applied.sequence,
      latest.sequence,
    );
    for (const record of [...older, latest]) {
      assertEquals(
        (await f.journal.result('home', 'in', record, record)) !== null,
        true,
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('an invalid newer auth snapshot cannot conceal an earlier valid deactivation', async () => {
  const f = await fixture();
  try {
    const earlier = await f.emit();
    await deactivateUser(f.ht, 'alice');
    const deactivated = await f.emit();
    const payload = structuredClone(deactivated.payload) as {
      signed: { body: AccountAuth };
    };
    payload.signed.body.capturedMs++;
    const invalid = await new Journal(await f.home.server(), LINK_SUPPORTED)
      .append('edge_a', {
        source: 'home',
        incarnation: f.bundle.id,
        stream: deactivated.stream,
        type: 'account-auth',
        version: 1,
        operationId: 'invalid-newer-snapshot',
        payload,
      });
    await f.journal.receive('home', [earlier, deactivated, invalid]);
    assertEquals(await f.receiver.apply(f.journal, deactivated), true);
    assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), false);
    assertEquals(
      (await f.journal.heads('home', 'in', deactivated)).applied.sequence,
      deactivated.sequence,
    );
    await assertRejects(
      () => f.receiver.apply(f.journal, invalid),
      LinkError,
      'invalid home account auth signature',
    );
    assertEquals(
      (await f.journal.heads('home', 'in', deactivated)).applied.sequence,
      deactivated.sequence,
    );
  } finally {
    await f.close();
  }
});

Deno.test('malformed signed authority tails cannot conceal a valid deactivation prefix', async (t) => {
  for (
    const malformed of [
      'null fact',
      'unknown kind',
      'null session',
      'unknown source',
      'missing dependency',
      'invalid localpart',
      'overlong localpart',
    ]
  ) {
    await t.step(malformed, async () => {
      const f = await fixture();
      try {
        await deactivateUser(f.ht, 'alice');
        const deactivated = await f.emit();
        const payload = structuredClone(deactivated.payload) as {
          after: number;
          signed: { body: AccountAuth; signature: string };
        };
        payload.after = payload.signed.body.sourceCut;
        payload.signed.body.sourceCut++;
        payload.signed.body.revision++;
        if (malformed === 'invalid localpart') {
          payload.signed.body.localpart = 'bad:account';
        }
        if (malformed === 'overlong localpart') {
          payload.signed.body.localpart = 'a'.repeat(256);
        }
        const authority = payload.signed.body.authority;
        if (malformed === 'null fact') {
          (authority.facts as unknown[]).push(null);
        }
        if (malformed === 'unknown kind') {
          (authority.facts as unknown[]).push({ kind: 'unknown' });
        }
        if (malformed === 'null session') {
          (authority.sessions as unknown[]).push(null);
        }
        const source = authority.facts[0];
        if (malformed === 'unknown source') {
          authority.facts.push({
            ...source,
            node: 'unselected',
            seq: source.seq + 1,
            id: canonicalJson([
              'unselected',
              source.incarnation,
              source.seq + 1,
            ]),
          });
        }
        if (malformed === 'missing dependency') {
          authority.sessions.push({
            hash: 'a'.repeat(64),
            node: source.node,
            incarnation: source.incarnation,
            localpart: 'alice',
            deviceId: 'missing',
            deviceIncarnation: 'missing',
            barriers: [],
            refresh: false,
            accessHash: null,
            nextHash: null,
            revision: 1,
          });
        }
        payload.signed.signature = await f.ht.signer().sign(
          canonicalJson(payload.signed.body),
        );
        const invalid = await new Journal(await f.home.server(), LINK_SUPPORTED)
          .append('edge_a', {
            source: 'home',
            incarnation: f.bundle.id,
            stream: deactivated.stream,
            type: 'account-auth',
            version: 1,
            operationId: 'malformed-signed-tail',
            payload,
          });
        await f.journal.receive('home', [deactivated, invalid]);
        assertEquals(await f.receiver.apply(f.journal, deactivated), true);
        assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), false);
        assertEquals(
          (await f.journal.heads('home', 'in', deactivated)).applied.sequence,
          deactivated.sequence,
        );
        assertEquals(
          await f.journal.result('home', 'in', invalid, invalid),
          null,
        );
        await assertRejects(
          () => f.receiver.apply(f.journal, invalid),
          LinkError,
          malformed.endsWith('localpart')
            ? 'invalid account localpart'
            : 'invalid session authority cut',
        );
        assertEquals(
          (await f.journal.heads('home', 'in', deactivated)).applied.sequence,
          deactivated.sequence,
        );
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('interrupted coalesced auth installation resumes its admitted prefix before a later received tail', async () => {
  const f = await fixture();
  try {
    const first = await f.emit();
    await f.journal.receive('home', [first]);
    await f.receiver.apply(f.journal, first);
    const older = await f.emit();
    await deactivateUser(f.ht, 'alice');
    const newest = await f.emit();
    await f.journal.receive('home', [older, newest]);
    const interrupted = new Proxy(f.journal, {
      get(journal, key) {
        if (key === 'apply') {
          return () =>
            Promise.reject(new Error('prefix completion interrupted'));
        }
        const value = Reflect.get(journal, key);
        return typeof value === 'function' ? value.bind(journal) : value;
      },
    });
    await assertRejects(
      () => f.receiver.apply(interrupted, newest),
      Error,
      'prefix completion interrupted',
    );
    assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), false);
    assertEquals(
      (await f.journal.heads('home', 'in', newest)).applied.sequence,
      first.sequence,
    );
    const later = await f.emit();
    await f.journal.receive('home', [later]);
    assertEquals(await f.receiver.apply(f.journal, later), true);
    assertEquals(
      (await f.journal.heads('home', 'in', newest)).applied.sequence,
      newest.sequence,
    );
    assertEquals(
      (await f.journal.pending('home', newest)).map((record) =>
        record.sequence
      ),
      [later.sequence],
    );
    assertEquals(await f.receiver.apply(f.journal, later), true);
    assertEquals(
      (await f.journal.heads('home', 'in', newest)).applied.sequence,
      later.sequence,
    );
  } finally {
    await f.close();
  }
});

Deno.test('auth publication rolls back with installation and survives cold loss of the server ACK', async () => {
  const f = await fixture();
  let cold: Awaited<ReturnType<typeof f.open>> | undefined;
  try {
    const record = await f.emit();
    await f.journal.receive('home', [record]);
    const db = await f.edge.tenant('logical.test');
    const rollback = new AccountSnapshots(
      new Proxy(f.edge, {
        get(store, key) {
          if (key === 'tenant') {
            return () =>
              Promise.resolve({
                ...db,
                tx: <T>(callback: Parameters<typeof db.tx<T>>[0]) =>
                  db.tx(async (conn) => {
                    await callback(conn);
                    throw new Error('before tenant commit');
                  }),
              });
          }
          const value = Reflect.get(store, key);
          return typeof value === 'function' ? value.bind(store) : value;
        },
      }),
      f.et,
      f.fp,
      f.owners,
    );
    await assertRejects(
      () => rollback.apply(f.journal, record),
      Error,
      'before tenant commit',
    );
    assertEquals(await db.query('SELECT * FROM account_auth_snapshots'), []);
    assertEquals(await db.query('SELECT * FROM account_auth_publications'), []);
    const interrupted = new Proxy(f.journal, {
      get(journal, key) {
        if (key === 'apply') {
          return () => Promise.reject(new Error('after tenant publication'));
        }
        const value = Reflect.get(journal, key);
        return typeof value === 'function' ? value.bind(journal) : value;
      },
    });
    await assertRejects(
      () => f.receiver.apply(interrupted, record),
      Error,
      'after tenant publication',
    );
    assertEquals(
      (await f.journal.heads('home', 'in', record)).applied.sequence,
      0,
    );
    await f.edge.close();
    cold = await f.open('edge');
    const fp = new Pairings(
      await cold.server(),
      f.node.signer(),
      f.node.publicKey,
      'b'.repeat(64),
      f.node,
    );
    const ingress = new FacadeAuth(
      await cold.server(),
      fp,
      f.node,
      new AuthLinkHealth({ notify: 'websocket', pollseconds: 1 }),
      {
        replicatecredentials: true,
        allowstaleauth: true,
        authmaxstalehours: 0,
      },
    );
    const tenant = await enrolledTenant(
      cold,
      fp,
      'logical.test',
      'edge_a',
      ingress,
    );
    assertEquals(await verifyUserPassword(tenant, 'alice', 'pw'), true);
    const journal = new Journal(await cold.server(), LINK_SUPPORTED);
    const owners = new OwnerControls(
      await cold.server(),
      await cold.tenant('logical.test'),
      fp,
      f.node,
    );
    const receiver = new AccountSnapshots(cold, tenant, fp, owners);
    assertEquals(await receiver.apply(journal, record), true);
    assertEquals(
      (await journal.heads('home', 'in', record)).applied.sequence,
      record.sequence,
    );
    assertEquals(await verifyUserPassword(tenant, 'alice', 'pw'), true);
    assertEquals(
      (await (await cold.tenant('logical.test')).query(
        'SELECT * FROM account_auth_publications',
      )).length,
      1,
    );
  } finally {
    await cold?.close();
    await f.close();
  }
});

Deno.test('facade prepared admission fences a tenant control or source cut changing before its transaction', async () => {
  const f = await fixture();
  try {
    const record = await f.emit();
    await f.journal.receive('home', [record]);
    await f.receiver.apply(f.journal, record);
    const guarded = await f.guarded({
      replicatecredentials: true,
      allowstaleauth: true,
      authmaxstalehours: 0,
    });
    const prepared = await guarded.ingress.prepare();
    const db = await f.edge.tenant('logical.test');
    await db.execute(
      'UPDATE account_auth_snapshots SET source_cut=source_cut+1',
    );
    await assertRejects(
      () =>
        db.tx((conn) =>
          prepared.check(conn, { kind: 'password', localpart: 'alice' })
        ),
      MatrixError,
      'authentication snapshot unavailable',
    );
    await db.execute(
      'UPDATE account_auth_snapshots SET source_cut=source_cut-1',
    );
    await db.execute('UPDATE facade_owner_activation SET revision=revision+1');
    await assertRejects(
      () =>
        db.tx((conn) =>
          prepared.check(conn, { kind: 'password', localpart: 'alice' })
        ),
      MatrixError,
      'authentication snapshot unavailable',
    );
  } finally {
    await f.close();
  }
});

Deno.test('permissive auth retains the prior complete snapshot while a successor is pending but cannot consume an unACKed tenant cut', async () => {
  const f = await fixture();
  try {
    const first = await f.emit();
    await f.journal.receive('home', [first]);
    await f.receiver.apply(f.journal, first);
    const guarded = await f.guarded({
      replicatecredentials: true,
      allowstaleauth: true,
      authmaxstalehours: 0,
    });
    const second = await f.emit();
    await f.journal.receive('home', [second]);
    await (await f.edge.server()).execute(
      'UPDATE facade_scopes SET ready=0,pending_hash=? WHERE scope=?',
      [second.hash, second.stream],
    );
    assertEquals(await verifyUserPassword(guarded.tenant, 'alice', 'pw'), true);
    await (await f.edge.tenant('logical.test')).execute(
      'UPDATE account_auth_snapshots SET source_cut=source_cut+1',
    );
    await assertRejects(
      () => verifyUserPassword(guarded.tenant, 'alice', 'pw'),
      MatrixError,
      'authentication snapshot unavailable',
    );
  } finally {
    await f.close();
  }
});

Deno.test('auth health binds asynchronous reconciliation evidence to its original live connection generation', () => {
  for (const notify of ['websocket', 'sse']) {
    const health = new AuthLinkHealth({ notify, pollseconds: 2 });
    const first = new AbortController(), second = new AbortController();
    const scope = 'auth:@a:logical.test';
    const head = { sequence: 1, hash: 'a'.repeat(64) };
    const declaration = [{
      source: 'home',
      incarnation: 'pair',
      stream: scope,
      head,
    }];
    const beforeAnyConnection = health.reconciliation();
    health.connected('pair', first.signal);
    beforeAnyConnection('pair', declaration);
    assertEquals(health.ready('pair', scope, head), false);
    health.observe('pair', declaration);
    assertEquals(health.ready('pair', scope, head), true);
    const delayed = health.reconciliation();
    first.abort();
    health.connected('pair', second.signal);
    delayed('pair', declaration);
    assertEquals(health.ready('pair', scope, head), false);
    // A delayed older-generation page still raises the monotone required head.
    const next = { sequence: 2, hash: 'b'.repeat(64) };
    delayed('pair', [{ ...declaration[0], head: next }]);
    health.observe('pair', declaration);
    assertEquals(health.ready('pair', scope, next), false);
    health.observe('pair', [{ ...declaration[0], head: next }]);
    assertEquals(health.ready('pair', scope, next), true);
    // Duplicate connection notification cannot erase or reset this generation.
    health.connected('pair', second.signal);
    assertEquals(health.ready('pair', scope, next), true);
    second.abort();
    assertEquals(health.ready('pair', scope, next), false);
  }
});

Deno.test('poll auth health uses configured reconciliation cadence and authenticates every declaration identity', () => {
  const health = new AuthLinkHealth({ notify: 'poll', pollseconds: 2 });
  const head = { sequence: 1, hash: 'a'.repeat(64) };
  const declaration = [{
    source: 'home',
    incarnation: 'pair',
    stream: 'auth:@a:logical.test',
    head,
  }];
  health.observe('pair', declaration, 1000);
  assertEquals(health.ready('pair', declaration[0].stream, head, 3000), true);
  assertEquals(health.ready('pair', declaration[0].stream, head, 3001), false);
  assertEquals(health.ready('pair', declaration[0].stream, head, 999), false);
  assertEquals(
    health.ready('other-pair', declaration[0].stream, head, 1000),
    false,
  );
  assertThrows(
    () =>
      health.observe('pair', [{ ...declaration[0], source: 'forged' }], 3001),
    LinkError,
  );
  assertThrows(
    () =>
      health.observe('pair', [{
        ...declaration[0],
        head: { ...head, hash: 'b'.repeat(64) },
      }], 3001),
    LinkError,
  );
  assertEquals(health.ready('pair', declaration[0].stream, head, 3001), false);
  health.observe('pair', [{
    ...declaration[0],
    stream: 'room:!r:logical.test',
  }], 3001);
  health.observe('pair', [{
    ...declaration[0],
    stream: 'auth:@other:logical.test',
  }], 3001);
  assertEquals(health.ready('pair', declaration[0].stream, head, 3001), false);
});

Deno.test('signed account auth crosses the negotiated journal and applies before its durable ACK without secrets in results', async () => {
  const f = await fixture();
  try {
    const record = await f.emit();
    const legacy = new Journal(await f.edge.server(), LINK_CAPABILITIES);
    await assertRejects(
      () => legacy.receive('home', [record]),
      LinkError,
      'unsupported record type',
    );
    await f.journal.receive('home', [record]);
    assertEquals(await f.receiver.apply(f.journal, record), true);
    assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), true);
    assertEquals(
      (await f.journal.heads('home', 'in', record)).applied.sequence,
      record.sequence,
    );
    const rows = await (await f.edge.server()).query(
      'SELECT result_json FROM facade_records WHERE stream=?',
      [record.stream],
    );
    assertEquals(canonicalJson(rows).includes('$argon2'), false);
    assertEquals(canonicalJson(record).includes('privkey'), false);
    const disabled = await f.emit(false);
    await f.journal.receive('home', [disabled]);
    await f.receiver.apply(f.journal, disabled);
    assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), false);
    assertEquals(
      await (await f.edge.tenant('logical.test')).query(
        'SELECT * FROM access_tokens',
      ),
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test('a forged account auth value never installs or advances its applied journal cut', async () => {
  const f = await fixture();
  try {
    const valid = await f.emit();
    const payload = structuredClone(valid.payload) as {
      signed: { signature: string; body: { phc: string | null } };
    };
    payload.signed.body.phc = null;
    const forged = await new Journal(await f.home.server(), LINK_SUPPORTED)
      .append('edge_a', {
        source: 'home',
        incarnation: f.bundle.id,
        stream: valid.stream + '-forged',
        type: 'account-auth',
        version: 1,
        operationId: 'forged-auth',
        payload,
      });
    await f.journal.receive('home', [forged]);
    await assertRejects(
      () => f.receiver.apply(f.journal, forged),
      LinkError,
      'invalid home account auth signature',
    );
    assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), false);
    assertEquals(
      (await f.journal.heads('home', 'in', forged)).applied.sequence,
      0,
    );
  } finally {
    await f.close();
  }
});

Deno.test('reconciliation retries the same durable auth export after a legacy reader upgrade', async () => {
  const f = await fixture();
  try {
    const record = await f.emit();
    const source = new Journal(await f.home.server(), LINK_SUPPORTED);
    let reader = new Journal(await f.edge.server(), LINK_CAPABILITIES);
    const errors: unknown[] = [];
    const sent: unknown[] = [];
    const limits = { maxBytes: 1000000, maxItems: 100 };
    const reconciler = new JournalReconciler({
      journal: source,
      limits,
      apply: () => Promise.resolve(false),
      failed: (error) => errors.push(error),
      client: {
        peer: {
          server: 'logical.test',
          node: 'edge_a',
          incarnation: f.node.incarnation,
          pairing: f.bundle.id,
          revision: 1,
        },
        hello: async () => ({
          revision: 1,
          scopes: [],
          incoming: await reader.streams('home', 'in'),
          outgoing: [],
          exportAcks: [],
        }),
        push: async (stream, records, after) => {
          if (stream.stream === record.stream) sent.push(...records);
          await reader.receive('home', records);
          if (stream.stream === record.stream) {
            while (await f.receiver.apply(reader, stream)) { /* Drain. */ }
          }
          return await reader.acknowledgement('home', stream, after, limits);
        },
        pull: () => Promise.reject(new Error('no facade source')),
        ack: () => Promise.reject(new Error('no facade source')),
        notices: async function* () {},
      },
    });
    await reconciler.reconcile();
    await reconciler.drain();
    assertEquals(errors.length > 0, true);
    assertEquals(
      (await source.acknowledged('edge_a', record)).received.sequence,
      0,
    );
    assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), false);
    reader = f.journal;
    errors.length = 0;
    await reconciler.reconcile();
    await reconciler.drain();
    assertEquals(errors, []);
    assertEquals(sent, [record, record]);
    assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), true);
    assertEquals(
      (await source.acknowledged('edge_a', record)).applied.sequence,
      record.sequence,
    );
    assertEquals(
      (await source.heads('edge_a', 'out', record)).received.sequence,
      record.sequence,
    );
  } finally {
    await f.close();
  }
});

for (const timing of ['queued', 'install', 'completion'] as const) {
  Deno.test(`obsolete auth advances only its source cut when ownership changes at ${timing}`, async () => {
    const f = await fixture();
    try {
      const old = await f.emit();
      await f.journal.receive('home', [old]);
      let receiver = f.receiver;
      if (timing === 'queued') await f.nextOwner();
      if (timing === 'install') {
        receiver = new AccountSnapshots(f.edge, f.et, f.fp, {
          ready: async () => {
            const prior = await f.owners.ready();
            await f.nextOwner();
            return prior;
          },
        });
      }
      if (timing === 'completion') {
        const db = await f.edge.tenant('logical.test');
        receiver = new AccountSnapshots(
          new Proxy(f.edge, {
            get: (store, key) => {
              if (key === 'tenant') {
                return () =>
                  Promise.resolve({
                    ...db,
                    tx: async <T>(callback: Parameters<typeof db.tx<T>>[0]) => {
                      const result = await db.tx(callback);
                      await f.nextOwner();
                      return result;
                    },
                  });
              }
              const value = Reflect.get(store, key);
              return typeof value === 'function' ? value.bind(store) : value;
            },
          }),
          f.et,
          f.fp,
          f.owners,
        );
      }
      assertEquals(await receiver.apply(f.journal, old), true);
      assertEquals(
        (await f.journal.heads('home', 'in', old)).applied.sequence,
        old.sequence,
      );
      const [scope] = await (await f.edge.server()).query(
        'SELECT source_cut,ready,pending_hash FROM facade_scopes WHERE scope=?',
        [old.stream],
      );
      const cut =
        (old.payload as { signed: { body: { sourceCut: number } } }).signed.body
          .sourceCut;
      assertEquals(scope, { source_cut: cut, ready: 0, pending_hash: null });
      if (timing !== 'completion') {
        assertEquals(
          await (await f.edge.tenant('logical.test')).query(
            'SELECT * FROM account_auth_snapshots',
          ),
          [],
        );
        assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), false);
      }
      await assertRejects(
        async () =>
          (await f.edge.tenant('logical.test')).tx((conn) =>
            requireAccountAuth(
              conn,
              'alice',
              { pairing: f.bundle.id, grantRevision: 1, ownerRevision: 2 },
              { allowstaleauth: true, authmaxstalehours: 0 },
              true,
              true,
            )
          ),
        MatrixError,
        'authentication snapshot unavailable',
      );
      const next = await f.emit();
      await f.journal.receive('home', [next]);
      assertEquals(await f.receiver.apply(f.journal, next), true);
      assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), true);
      assertEquals(
        (await f.journal.heads('home', 'in', next)).applied.sequence,
        next.sequence,
      );
      assertEquals(
        (await (await f.edge.server()).query(
          'SELECT ready FROM facade_scopes WHERE scope=?',
          [next.stream],
        ))[0].ready,
        1,
      );
    } finally {
      await f.close();
    }
  });
}

Deno.test('future auth waits for its control and a forged obsolete auth never consumes the source cut', async () => {
  const f = await fixture();
  try {
    const owner = await f.nextOwner(false);
    const future = await f.emit();
    await f.journal.receive('home', [future]);
    await assertRejects(() => f.receiver.apply(f.journal, future), LinkError);
    assertEquals(
      (await f.journal.heads('home', 'in', future)).applied.sequence,
      0,
    );
    await f.owners.apply(f.journal, owner);
    assertEquals(await f.receiver.apply(f.journal, future), true);
    const payload = structuredClone(future.payload) as {
      after: number;
      signed: { body: { ownerRevision: number } };
    };
    payload.after = payload.after + 1;
    payload.signed.body.ownerRevision = 1;
    const forged = await new Journal(await f.home.server(), LINK_SUPPORTED)
      .append('edge_a', {
        source: 'home',
        incarnation: f.bundle.id,
        stream: future.stream,
        type: 'account-auth',
        version: 1,
        operationId: 'forged-obsolete',
        payload,
      });
    await f.journal.receive('home', [forged]);
    await assertRejects(
      () => f.receiver.apply(f.journal, forged),
      LinkError,
      'invalid home account auth signature',
    );
    assertEquals(
      (await f.journal.heads('home', 'in', future)).applied.sequence,
      future.sequence,
    );
  } finally {
    await f.close();
  }
});

// Construct the signed wire body independently of the production exporter so
// receiver tests do not accidentally bless its normalization/identity choices.
async function reverseFixture() {
  const f = await fixture();
  const initial = await f.emit();
  await f.journal.receive('home', [initial]);
  await f.receiver.apply(f.journal, initial);
  const source = new Journal(await f.edge.server(), LINK_SUPPORTED);
  const destination = new Journal(await f.home.server(), LINK_SUPPORTED);
  const receiver = new AccountSnapshots(f.home, f.ht, f.hp, f.owners);
  const capture = () =>
    (f.edge.tenant('logical.test')).then((db) =>
      db.tx((conn) => captureSessionAuthority(conn, 'alice'))
    );
  const emit = async (
    change: (body: Record<string, unknown>) => void = () => {},
    signer = f.node.signer(),
  ) => {
    const cut = await capture();
    const body = {
      kind: 'session-authority',
      server: 'logical.test',
      pairing: f.bundle.id,
      grantRevision: 1,
      ownerRevision: 1,
      localpart: 'alice',
      source: f.node.node,
      incarnation: f.node.incarnation,
      authority: {
        facts: cut.facts.filter((fact) => fact.node === f.node.node),
        sessions: cut.sessions.filter((session) =>
          session.node === f.node.node
        ),
      },
    };
    change(body);
    const record = await source.append('home', {
      source: f.node.node,
      incarnation: f.node.incarnation,
      stream: 'authority:@alice:logical.test',
      type: 'account-auth',
      version: 1,
      operationId: crypto.randomUUID(),
      payload: { body, signature: await signer.sign(canonicalJson(body)) },
    });
    await destination.receive(f.node.node, [record]);
    return record;
  };
  return {
    ...f,
    source,
    destination,
    reverse: receiver,
    capture,
    reverseEmit: emit,
  };
}

Deno.test('facade authority reaches home durably before ACK and never becomes a second token issuer', async () => {
  const f = await reverseFixture();
  try {
    const session = await loginUser(f.et, {
      localpart: 'alice',
      password: 'pw',
      deviceId: 'outside',
      refresh: true,
    });
    const record = await f.reverseEmit();
    assertEquals(
      await f.reverse.applyFromFacade(f.destination, f.bundle.id, record),
      true,
    );
    await assertRejects(
      () => lookupToken(f.ht, session.accessToken),
      MatrixError,
      'operation owner unavailable',
    );
    assertEquals(
      await (await f.home.tenant('logical.test')).query(
        'SELECT * FROM access_tokens',
      ),
      [],
    );
    assertEquals(
      (await f.destination.heads(f.node.node, 'in', record)).applied.sequence,
      record.sequence,
    );
    assertEquals(canonicalJson(record).includes(session.accessToken), false);
    assertEquals(canonicalJson(record).includes(session.refreshToken!), false);
    assertEquals(canonicalJson(record).includes('$argon2'), false);
    assertEquals(
      await f.reverse.applyFromFacade(f.destination, f.bundle.id, record),
      false,
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade logout barrier invalidates a concurrently issued home session at the consumer', async () => {
  const f = await reverseFixture();
  try {
    const session = await loginUser(f.ht, {
      localpart: 'alice',
      password: 'pw',
      deviceId: 'lan',
      refresh: true,
    });
    await revokeAllTokens(f.et, 'alice');
    const record = await f.reverseEmit();
    await f.reverse.applyFromFacade(f.destination, f.bundle.id, record);
    await assertRejects(
      () => lookupToken(f.ht, session.accessToken),
      MatrixError,
      'session authority revoked',
    );
    assertEquals(
      await (await f.home.tenant('logical.test')).query(
        'SELECT * FROM refresh_tokens',
      ),
      [],
    );
    const fresh = await loginUser(f.ht, {
      localpart: 'alice',
      password: 'pw',
      deviceId: 'later',
      refresh: false,
    });
    assertEquals(
      (await lookupToken(f.ht, fresh.accessToken))?.device_id,
      'later',
    );
  } finally {
    await f.close();
  }
});

for (
  const attack of [
    'signature',
    'source',
    'account',
    'home-fact',
    'home-session',
    'null-fact',
    'null-session',
    'unknown-kind',
    'grant',
    'stream',
  ] as const
) {
  Deno.test(`facade authority refuses ${attack} substitution without an applied ACK`, async () => {
    const f = await reverseFixture();
    try {
      const homeSession = await loginUser(f.ht, {
        localpart: 'alice',
        password: 'pw',
        deviceId: 'lan',
        refresh: true,
      });
      const homeCut = await (await f.home.tenant('logical.test')).tx((conn) =>
        captureSessionAuthority(conn, 'alice')
      );
      const record = await f.reverseEmit((body) => {
        if (attack === 'source') body.source = 'somewhere-else';
        if (attack === 'account') body.localpart = 'unselected';
        if (attack === 'grant') body.grantRevision = 2;
        const authority = body.authority as typeof homeCut;
        if (attack === 'null-fact') (authority.facts as unknown[]).push(null);
        if (attack === 'null-session') {
          (authority.sessions as unknown[]).push(null);
        }
        if (attack === 'unknown-kind') {
          (authority.facts as unknown[]).push({ kind: 'unknown' });
        }
        if (attack === 'home-fact') authority.facts.push(homeCut.facts[0]);
        if (attack === 'home-session') {
          authority.sessions.push(homeCut.sessions[0]);
        }
      }, attack === 'signature' ? f.ht.signer() : f.node.signer());
      let stream = record;
      if (attack === 'stream') {
        stream = await f.source.append('home', {
          ...record,
          stream: 'authority:@bob:logical.test',
          operationId: crypto.randomUUID(),
        });
        await f.destination.receive(f.node.node, [stream]);
      }
      await assertRejects(
        () => f.reverse.applyFromFacade(f.destination, f.bundle.id, stream),
        LinkError,
      );
      assertEquals(
        (await f.destination.heads(f.node.node, 'in', stream)).applied.sequence,
        0,
      );
      assertEquals(
        (await lookupToken(f.ht, homeSession.accessToken))?.device_id,
        'lan',
      );
    } finally {
      await f.close();
    }
  });
}

Deno.test('facade exporter retains only its own digest recovery and cross-ingress deletes target known home incarnations', async () => {
  const f = await reverseFixture();
  try {
    const lan = await loginUser(f.ht, {
      localpart: 'alice',
      password: 'pw',
      deviceId: 'lan',
      refresh: true,
    });
    const cut = await f.emit();
    await f.journal.receive('home', [cut]);
    await f.receiver.apply(f.journal, cut);
    await loginUser(f.et, {
      localpart: 'alice',
      password: 'pw',
      deviceId: 'outside',
      refresh: true,
    });
    await deleteDevices(f.et, 'alice', ['lan']);
    const record = await exportSessionAuthority(
      f.edge,
      f.et,
      f.fp,
      f.owners,
      f.node,
      'alice',
    );
    const again = await exportSessionAuthority(
      f.edge,
      f.et,
      f.fp,
      f.owners,
      f.node,
      'alice',
    );
    assertEquals(again, record);
    const authority = (record.payload as {
      body: { authority: Awaited<ReturnType<typeof f.capture>> };
    }).body.authority;
    assertEquals(
      authority.facts.every((fact) => fact.node === f.node.node),
      true,
    );
    assertEquals(
      authority.sessions.every((session) => session.node === f.node.node),
      true,
    );
    assertEquals(canonicalJson(record).includes('$argon2'), false);
    await f.destination.receive(f.node.node, [record]);
    await f.reverse.applyFromFacade(f.destination, f.bundle.id, record);
    await assertRejects(
      () => lookupToken(f.ht, lan.accessToken),
      MatrixError,
      'session authority revoked',
    );
    assertEquals(await f.ht.tx((tx) => tx.devices.byId('lan', 'alice')), null);
  } finally {
    await f.close();
  }
});

Deno.test('reverse authority retries a committed tenant cut after cold reopen without an early journal ACK', async () => {
  const f = await reverseFixture();
  let cold: Awaited<ReturnType<typeof f.open>> | undefined;
  try {
    const token = await loginUser(f.ht, {
      localpart: 'alice',
      password: 'pw',
      deviceId: 'lan',
      refresh: true,
    });
    await revokeAllTokens(f.et, 'alice');
    const record = await f.reverseEmit();
    const interrupted = new Proxy(f.destination, {
      get(journal, key) {
        if (key === 'apply') {
          return () => Promise.reject(new Error('after tenant commit'));
        }
        const value = Reflect.get(journal, key);
        return typeof value === 'function' ? value.bind(journal) : value;
      },
    });
    await assertRejects(
      () => f.reverse.applyFromFacade(interrupted, f.bundle.id, record),
      Error,
      'after tenant commit',
    );
    assertEquals(
      (await f.destination.heads(f.node.node, 'in', record)).applied.sequence,
      0,
    );
    await f.home.close();
    cold = await f.open('home');
    const tenant = await openTenant(cold, 'logical.test');
    const pairings = new Pairings(
      await cold.server(),
      tenant.signer(),
      tenant.publicB64,
      'a'.repeat(64),
    );
    const journal = new Journal(await cold.server(), LINK_SUPPORTED);
    const receiver = new AccountSnapshots(cold, tenant, pairings, f.owners);
    await assertRejects(
      () => lookupToken(tenant, token.accessToken),
      MatrixError,
      'session authority revoked',
    );
    assertEquals(
      await receiver.applyFromFacade(journal, f.bundle.id, record),
      true,
    );
    assertEquals(
      (await journal.heads(f.node.node, 'in', record)).applied.sequence,
      record.sequence,
    );
    const facts = await (await cold.tenant('logical.test')).query(
      "SELECT id FROM authority_facts WHERE kind='barrier'",
    );
    assertEquals(facts.length, 1);
  } finally {
    await cold?.close();
    await f.close();
  }
});

Deno.test('account export drains independent users fairly and shutdown waits for admitted work', async () => {
  const f = await fixture();
  const hold = Promise.withResolvers<void>(),
    other = Promise.withResolvers<void>();
  const emitted: string[] = [];
  const errors: unknown[] = [];
  const worker = startAccountExports({
    store: f.home,
    tenant: f.ht,
    pollseconds: 60,
    users: () => Promise.resolve(['alice', 'bob']),
    emit: async (user) => {
      emitted.push(user);
      if (user === 'alice') await hold.promise;
      else other.resolve();
    },
    changed: () => {},
    failed: (error) => errors.push(error),
  });
  try {
    await bounded(other.promise);
    assertEquals(emitted, ['alice', 'bob']);
    let closed = false;
    const closing = worker.close().then(() => closed = true);
    await Promise.resolve();
    assertEquals(closed, false);
    hold.resolve();
    await bounded(closing);
    assertEquals(errors, []);
  } finally {
    hold.resolve();
    await worker.close();
    await f.close();
  }
});
