import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  initializeNode,
  loadNode,
  readProtectedFile,
} from '#engine/facade/identity.ts';
import { LinkError } from '#engine/facade/protocol.ts';
import {
  importPublicKeyFromRaw,
  matrixBase64,
} from '#engine/signing-primitives.js';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';

const cfg = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

Deno.test('explicit facade identity preserves common server name and unique signer across reopen', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-identity-' });
  let store = await openStore(cfg(dir), { schemas: { server: serverSchema } });
  try {
    const db = await store.server();
    await assertRejects(
      () => loadNode(db, 'logical.test', 'edge_a'),
      LinkError,
      'not been initialized',
    );
    assertEquals(await store.tenants(), []);
    const node = await initializeNode(db, 'logical.test', 'edge_a');
    const signer = node.signer();
    assertEquals(signer.serverName, 'logical.test');
    assert(/^ed25519:edge_a_[a-f0-9]+$/.test(signer.keyId));
    const publicKey = await importPublicKeyFromRaw(
      matrixBase64(node.publicKey, 32),
    );
    assert(
      await crypto.subtle.verify(
        'Ed25519',
        publicKey,
        matrixBase64(await signer.sign('proof'), 64),
        new TextEncoder().encode('proof'),
      ),
    );
    await assertRejects(
      () => initializeNode(db, 'other.test', 'edge_a'),
      LinkError,
    );
    await assertRejects(
      () => initializeNode(db, 'logical.test', 'edge_b'),
      LinkError,
    );
    await store.close();
    store = await openStore(cfg(dir), { schemas: { server: serverSchema } });
    const again = await initializeNode(
      await store.server(),
      'logical.test',
      'edge_a',
    );
    assertEquals(again.publicKey, node.publicKey);
    assertEquals(again.keyId, node.keyId);
    assertEquals(again.incarnation, node.incarnation);
    assertEquals(await store.tenants(), []);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('corrupt stored facade authority is refused and never regenerated', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-corrupt-' });
  const store = await openStore(cfg(dir), {
    schemas: { server: serverSchema },
  });
  try {
    const db = await store.server();
    const node = await initializeNode(db, 'logical.test', 'edge_a');
    await db.execute('UPDATE facade_node SET key_id=?', ['ed25519:wrong']);
    await assertRejects(
      () => initializeNode(db, 'logical.test', 'edge_a'),
      LinkError,
    );
    assertEquals(await db.query('SELECT public_key,key_id FROM facade_node'), [{
      public_key: node.publicKey,
      key_id: 'ed25519:wrong',
    }]);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('link private files refuse symlinks and permissive modes', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-protected-' });
  const path = dir + '/pair.json';
  try {
    await Deno.writeTextFile(path, 'protected', { mode: 0o600 });
    assertEquals(await readProtectedFile(path), 'protected');
    await Deno.chmod(path, 0o644);
    await assertRejects(() => readProtectedFile(path), LinkError);
    await Deno.chmod(path, 0o600);
    await Deno.symlink(path, dir + '/alias');
    await assertRejects(() => readProtectedFile(dir + '/alias'), LinkError);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
