// tests/tenant-identity.test.ts — the tenant file's identity (the old
// tenant.test.ts "key generate-once, native name shape", ported): the
// ed25519 keypair is generated once and reused across reopen, the native
// name is the base32 of the key, and the signer's output verifies with
// the stored public key. The old tenantDbName assertion is dropped — the
// store's layout owns file keys now.
import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from '@std/assert';
import { openStore, type Store } from '#engine/store/index.ts';
import {
  nativeNameFor,
  openTenant,
  signingKeyVersionFor,
  tenantSchema,
} from '#engine/tenant/index.ts';
import { b64decode } from '#engine/signing-primitives.js';

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

async function withStore(
  fn: (store: Store, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(config(dir), {
    schemas: { tenant: tenantSchema },
  });
  try {
    await fn(store, dir);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('tenant: key generate-once, reused across reopen; native name from the key', async () => {
  const dir = await Deno.makeTempDir();
  try {
    let publicB64 = '';
    let nativeName = '';
    let keyId = '';
    // Three opens: twice on one store, then a fresh store (a restart).
    for (let open = 0; open < 3; open++) {
      const store = await openStore(config(dir), {
        schemas: { tenant: tenantSchema },
      });
      try {
        const tenant = await openTenant(store, 'a.test', { create: true });
        if (open === 0) {
          publicB64 = tenant.publicB64;
          nativeName = tenant.nativeName;
          keyId = tenant.keyId;
        } else {
          assertEquals(tenant.publicB64, publicB64, 'reopen must not rotate');
          assertEquals(tenant.nativeName, nativeName);
          assertEquals(tenant.keyId, keyId);
        }
      } finally {
        await store.close();
      }
    }
    assertMatch(nativeName, /^[a-z2-7]{52}$/);
    assertEquals(nativeName, nativeNameFor(b64decode(publicB64)));
    assertMatch(keyId, /^ed25519:[a-zA-Z0-9_]+$/);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('tenant: signer output verifies with the stored public key', async () => {
  await withStore(async (store) => {
    const tenant = await openTenant(store, 'a.test', { create: true });
    const signer = tenant.signer();
    assertEquals(signer.serverName, 'a.test');
    assertEquals(signer.keyId, tenant.keyId);
    const canonical = '{"a":1}';
    const signature = await signer.sign(canonical);
    const publicKey = await crypto.subtle.importKey(
      'raw',
      b64decode(tenant.publicB64),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    assert(
      await crypto.subtle.verify(
        { name: 'Ed25519' },
        publicKey,
        b64decode(signature),
        new TextEncoder().encode(canonical),
      ),
    );
    // A second signer() call signs with the same key.
    assertEquals(await tenant.signer().sign(canonical), signature);
  });
});

Deno.test('tenant: open without create on a missing file refuses', async () => {
  await withStore(async (store) => {
    await assertRejects(
      () => openTenant(store, 'missing.test'),
      Deno.errors.NotFound,
    );
  });
});

Deno.test('tenant: existing file without authority never triggers implicit identity generation', async () => {
  await withStore(async (store) => {
    const db = await store.tenant('a.test', { create: true });
    await assertRejects(() => openTenant(store, 'a.test'), Error, 'identity');
    assertEquals(await db.query('SELECT server_name FROM tenant'), []);
  });
});

Deno.test('tenant: fresh stores for the same server name get distinct signing key ids', async () => {
  await withStore(async (first) => {
    await withStore(async (second) => {
      const oldTenant = await openTenant(first, 'same.test', { create: true });
      const newTenant = await openTenant(second, 'same.test', { create: true });
      assertNotEquals(newTenant.publicB64, oldTenant.publicB64);
      assertNotEquals(newTenant.keyId, oldTenant.keyId);
      // The persisted suffix, not a reader-generated value, owns the identity.
      for (
        const [store, tenant] of [[first, oldTenant], [
          second,
          newTenant,
        ]] as const
      ) {
        const db = await store.tenant('same.test');
        const rows = await db.tx((conn) =>
          conn.query('SELECT key_id FROM tenant')
        );
        assertEquals('ed25519:' + rows[0].key_id, tenant.keyId);
        assertMatch(tenant.keyId, /^ed25519:[a-zA-Z0-9_]+$/);
      }
    });
  });
});

Deno.test('tenant: signing key version uses the spec alphabet for a fixed hyphen-producing hash', async () => {
  // Ed25519 public key from the fixed seed consisting of 32 bytes of 15.
  // Its SHA256 starts 795ed5ffe903; base64url starts eV7V_-kD (invalid '-').
  const raw = b64decode('2b8hSHSKhcidparY7gsPwtEF_TnUGkx5ZTY1TwrikAw');
  const version = await signingKeyVersionFor(raw);
  assertMatch('ed25519:' + version, /^ed25519:[a-zA-Z0-9_]+$/);
  assertEquals(version, '795ed5ffe903');
});
