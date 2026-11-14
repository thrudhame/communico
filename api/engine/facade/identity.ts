// Explicit facade initialization, never the home tenant's implicit genesis.
// Neither this owner nor its status view exports private material.
import { createHash } from 'node:crypto';
import type { Database } from '#engine/store/db.ts';
import type { Signer } from '#engine/room/signer.ts';
import {
  b64decode,
  b64encodeStd,
  exportPrivateKeyPkcs8,
  exportPublicKeyRaw,
  generateSigningKeypair,
  importPrivateKeyFromPkcs8,
  importPublicKeyFromRaw,
  matrixBase64,
} from '#engine/signing-primitives.js';
import { LinkError, text } from './protocol.ts';
import type { Pairings } from './pairing.ts';
import type { Store } from '#engine/store/index.ts';
import { provisionTenant, type Tenant } from '#engine/tenant/index.ts';

/** Cross-file provisioning is recoverable: replay installs the same granted
 * local key through the tenant owner, never home identity genesis or row clone. */
export async function enrolledTenant(
  store: Store,
  pairings: Pairings,
  server: string,
  node: string,
): Promise<Tenant> {
  const grant = await pairings.active();
  const db = await store.server();
  const identity = await loadNode(db, server, node);
  const transcript = grant.body.transcript.body;
  if (
    transcript.context.server !== server || transcript.context.node !== node ||
    transcript.incarnation !== identity.incarnation ||
    transcript.key.keyId !== identity.keyId ||
    transcript.key.publicKey !== identity.publicKey
  ) {
    throw new LinkError(
      'LINK_IDENTITY_MISMATCH',
      'grant belongs to another local node',
      403,
    );
  }
  const [row] = await db.query(
    'SELECT private_key FROM facade_node WHERE singleton=1',
  );
  return await provisionTenant(store, server, {
    keyId: identity.keyId,
    publicB64: identity.publicKey,
    privateB64: String(row.private_key),
  });
}

export type NodeIdentity = {
  readonly server: string;
  readonly node: string;
  readonly incarnation: string;
  readonly keyId: string;
  readonly publicKey: string;
  signer(): Signer;
};

export function nodeId(value: unknown): string {
  const id = text(value);
  if (!/^[A-Za-z0-9_]+$/.test(id) || id === 'home') {
    throw new LinkError(
      'LINK_IDENTITY_MISMATCH',
      'facade node ID must use letters, digits or underscore and must not be home',
      400,
    );
  }
  return id;
}
function keyIdFor(node: string, raw: Uint8Array): string {
  return 'ed25519:' + node + '_' +
    createHash('sha256').update(raw).digest('hex');
}

/** Missing/corrupt existing identity is a failure, not authorization to mint. */
export async function loadNode(
  db: Database,
  server: string,
  node: string,
): Promise<NodeIdentity> {
  const rows = await db.query(
    'SELECT server_name,node_id,incarnation,key_id,public_key,private_key FROM facade_node WHERE singleton=1',
  );
  if (rows.length !== 1) {
    throw new LinkError(
      'LINK_UNPAIRED',
      'facade node has not been initialized',
      503,
    );
  }
  const row = rows[0];
  if (row.server_name !== server || row.node_id !== node) {
    throw new LinkError(
      'LINK_IDENTITY_MISMATCH',
      'facade store belongs to another server or node',
      403,
    );
  }
  const raw = matrixBase64(row.public_key, 32);
  const keyId = keyIdFor(nodeId(node), raw);
  if (row.key_id !== keyId) {
    throw new LinkError(
      'LINK_IDENTITY_MISMATCH',
      'facade key ID does not match public key',
      403,
    );
  }
  const publicKey = await importPublicKeyFromRaw(raw);
  const privateKey = await importPrivateKeyFromPkcs8(
    b64decode(String(row.private_key)),
  );
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const signature = await crypto.subtle.sign('Ed25519', privateKey, challenge);
  if (!await crypto.subtle.verify('Ed25519', publicKey, signature, challenge)) {
    throw new LinkError(
      'LINK_IDENTITY_MISMATCH',
      'facade public and private keys do not match',
      403,
    );
  }
  const identity = {
    server,
    node,
    incarnation: text(row.incarnation),
    keyId,
    publicKey: String(row.public_key),
  };
  return {
    ...identity,
    signer: () => ({
      serverName: server,
      keyId,
      sign: async (canonical: string) =>
        b64encodeStd(
          new Uint8Array(
            await crypto.subtle.sign(
              'Ed25519',
              privateKey,
              new TextEncoder().encode(canonical),
            ),
          ),
        ),
    }),
  };
}

/** This is an explicit local admin operation. A retry reuses existing identity;
 * a different node/name or corrupt key never regenerates it. */
export async function initializeNode(
  db: Database,
  server: string,
  rawNode: string,
): Promise<NodeIdentity> {
  const node = nodeId(rawNode);
  text(server);
  const present = await db.query('SELECT singleton FROM facade_node');
  if (present.length) return await loadNode(db, server, node);
  // Crypto generation is outside the retryable transaction. Concurrent explicit
  // initialization is fenced by the singleton; the loser reloads the winner.
  const pair = await generateSigningKeypair() as CryptoKeyPair;
  const raw = await exportPublicKeyRaw(pair.publicKey);
  const privateRaw = await exportPrivateKeyPkcs8(pair.privateKey);
  const incarnation = crypto.randomUUID();
  const keyId = keyIdFor(node, raw);
  const created = Date.now();
  await db.tx(async (conn) => {
    await conn.execute(
      'INSERT INTO facade_node(singleton,server_name,node_id,incarnation,key_id,public_key,private_key,created_ms) VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(singleton) DO NOTHING',
      [
        server,
        node,
        incarnation,
        keyId,
        b64encodeStd(raw),
        b64encodeStd(privateRaw),
        created,
      ],
    );
  });
  return await loadNode(db, server, node);
}

/** Operator-supplied enrollment/private TLS files stay local and protected. */
export async function readProtectedFile(path: string): Promise<string> {
  // Opening the descriptor then comparing lstat/fstat prevents a symlink swap
  // from redirecting a protected read to another inode between check and read.
  const before = await Deno.lstat(path);
  const uid = Deno.uid();
  if (
    !before.isFile || before.isSymlink || before.uid !== uid ||
    (before.mode! & 0o7777) !== 0o600
  ) {
    throw new LinkError(
      'LINK_UNSAFE_FILE',
      'link private file must be a runtime-owned regular file with mode 0600',
      403,
    );
  }
  using file = await Deno.open(path, { read: true });
  const bound = await file.stat();
  if (
    before.ino !== bound.ino || before.dev !== bound.dev || bound.uid !== uid ||
    (bound.mode! & 0o7777) !== 0o600
  ) {
    throw new LinkError(
      'LINK_UNSAFE_FILE',
      'link private file changed while opening',
      403,
    );
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = new Uint8Array(65536);
    const count = await file.read(chunk);
    if (count === null) break;
    chunks.push(chunk.subarray(0, count));
    size += count;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
