import { createHash } from 'node:crypto';
import type { CapturedQuery } from '#engine/store/inspect.ts';
import {
  auditFailure,
  counterCeiling,
  counters,
  nonnegative,
} from '#engine/backup/checks.ts';
import { nativeNameFor } from './index.ts';
import {
  b64decode,
  importPrivateKeyFromPkcs8,
  importPublicKeyFromRaw,
} from '#engine/signing-primitives.js';
import type { Manifest } from '#engine/backup/manifest.ts';

export async function auditTenant(db: CapturedQuery, id: string) {
  const rows = await db.query(
    'SELECT server_name,native_name,key_id,pubkey_b64,privkey_enc FROM tenant',
  );
  if (rows.length !== 1 || rows[0].server_name !== id) {
    auditFailure('tenant identity mismatch');
  }
  const row = rows[0];
  const pub = b64decode(String(row.pubkey_b64));
  try {
    const privateKey = await importPrivateKeyFromPkcs8(
      b64decode(String(row.privkey_enc)),
    );
    const publicKey = await importPublicKeyFromRaw(pub);
    const challenge = new TextEncoder().encode(
      'communico backup identity audit',
    );
    const signature = await crypto.subtle.sign(
      'Ed25519',
      privateKey,
      challenge,
    );
    if (
      !await crypto.subtle.verify('Ed25519', publicKey, signature, challenge) ||
      nativeNameFor(pub) !== row.native_name
    ) auditFailure('signing identity mismatch');
  } catch {
    auditFailure('signing identity mismatch');
  }
  if (typeof row.key_id !== 'string' || !/^[A-Za-z0-9_]+$/.test(row.key_id)) {
    auditFailure('invalid signing key id');
  }
  const identity: Manifest['tenants'][number] = {
    id,
    nativeName: String(row.native_name),
    keyId: 'ed25519:' + row.key_id,
    publicKey: String(row.pubkey_b64),
    fingerprint: createHash('sha256').update(pub).digest('hex'),
  };
  const heads = await counters(db);
  for (const table of ['account_changes', 'e2ee_changes', 'pusher_changes']) {
    const [{ head }] = await db.query(
      `SELECT COALESCE(MAX(pos),0) AS head FROM ${table}`,
    );
    heads['source:' + table] = nonnegative(head, 'invalid source head');
  }
  for (
    const [counter, table, column] of [
      ['account_data', 'account_data', 'seq'],
      ['account_data', 'push_rules', 'seq'],
      ['account_data', 'push_rules_stream', 'seq'],
      ['account_changes', 'account_changes', 'pos'],
      ['e2ee_changes', 'e2ee_changes', 'pos'],
      ['pusher_changes', 'pusher_changes', 'pos'],
      ['to_device', 'to_device_inbox', 'msg_pos'],
      ['key_upload', 'one_time_keys', 'upload_pos'],
      ['key_pools', 'key_pool_updates', 'seq'],
      ['device_generation', 'devices', 'generation'],
      ['cross_signing', 'cross_signing_keys', 'revision'],
    ]
  ) await counterCeiling(db, heads, counter, table, column);
  const media = (await db.query(
    "SELECT media_id,size_bytes FROM media WHERE state='uploaded' ORDER BY media_id",
  )).map((m) => {
    if (
      typeof m.media_id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(m.media_id)
    ) auditFailure('invalid local media id');
    return {
      tenant: id,
      id: m.media_id,
      path: 'media/' + m.media_id,
      size: nonnegative(m.size_bytes, 'invalid local media size'),
    };
  });
  return { identity, heads, media };
}
