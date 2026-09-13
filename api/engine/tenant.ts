// api/engine/tenant.ts — per-tenant identity (F1). A tenant = one identity
// DB + its room DBs + hat config; single vs multi is N = 1 (design §4.2).
// The tenant holds the ed25519 signing keypair (generate-once,
// reuse-forever); hosted users are localparts under it (custodial,
// argon2id credentials — see BLOCKER-F1-CREDENTIALS.md).
import { encodeBase32 } from '@std/encoding/base32';
import { hash as argonHash, verify as argonVerify } from '@stdext/crypto/hash/argon2';
import { serverDb, ident, withDb } from './db.ts';
import { serverName } from './config.ts';
import { runSqlFile } from './room.ts';
import { MatrixError } from './matrix-error.ts';
import {
  b64decode,
  b64encode,
  exportPrivateKeyPkcs8,
  exportPublicKeyRaw,
  generateSigningKeypair,
  importPrivateKeyFromPkcs8,
  importPublicKeyFromRaw,
} from '#engine/signing-primitives.js';

async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function tenantDbName(dnsName = serverName()): Promise<string> {
  return sha256hex(dnsName).then((h) => 'tenant_' + h.slice(0, 20));
}

// Native server name: the tenant key as lowercase unpadded base32, one DNS
// label (52 chars for ed25519). Grammar-legal per the spec appendices
// (server_name = hostname; dns-char covers alphanumerics + hyphen).
export function nativeNameFor(pubRaw: Uint8Array): string {
  return encodeBase32(pubRaw).replace(/=+$/, '').toLowerCase();
}

export interface TenantKey {
  keyId: string;
  serverName: string;
  nativeName: string;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicB64: string;
}

// OWASP argon2id defaults (BLOCKER-F1-CREDENTIALS.md): m=19456 KiB, t=2,
// p=1. The PHC string encodes algorithm+params+salt in-band.
const ARGON_OPTS = {
  algorithm: 'argon2id',
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): string {
  return argonHash(password, { ...ARGON_OPTS });
}

export function verifyPassword(phc: string, password: string): boolean {
  try {
    return argonVerify(password, phc, { ...ARGON_OPTS });
  } catch {
    return false;
  }
}

// Spec appendices: user_id_localpart = 1*user_id_char;
// user_id_char = DIGIT / a-z / "-" / "." / "=" / "_" / "/" / "+".
// Downcased before validation (Complement checks downcasing explicitly).
const LOCALPART_RE = /^[a-z0-9._=\-/+]+$/;

export function checkLocalpart(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new MatrixError(400, 'M_INVALID_USERNAME', 'username required');
  }
  const localpart = raw.toLowerCase();
  if (!LOCALPART_RE.test(localpart) || localpart.length > 255) {
    throw new MatrixError(400, 'M_INVALID_USERNAME', 'invalid username: ' + raw);
  }
  return localpart;
}

// Create the tenant DB once (idempotent) and settle its signing key:
// migrate the F0 dev key, generate fresh when neither exists, and NEVER
// rotate silently (a restart must not change who the server is).
export async function ensureTenant(
  dnsName = serverName(),
): Promise<{ dbName: string; key: TenantKey }> {
  const dbName = await tenantDbName(dnsName);
  await withDb(serverDb(), async (c) => {
    try {
      await c.query(`CREATE DATABASE ${ident(dbName)};`);
    } catch (e) {
      // Doltgres: "can't create database X; database exists"
      if (!/exists/i.test(String(e))) throw e;
    }
  });
  await withDb(dbName, async (c) => {
    await runSqlFile(c, 'db/tenant/schema.sql');
  });

  // F0 dev key (migration source, if present).
  let f0: { keyId: string; pubB64: string; privB64: string } | null = null;
  await withDb(serverDb(), async (c) => {
    const t = await c.query(
      'SELECT key_id, pubkey_b64, privkey_pkcs8_b64 FROM server_signing_key LIMIT 1;',
    ).catch(() => ({ rows: [] as unknown[] }));
    if (t.rows.length > 0) {
      const row = t.rows[0] as Record<string, unknown>;
      f0 = {
        keyId: String(row.key_id),
        pubB64: String(row.pubkey_b64),
        privB64: String(row.privkey_pkcs8_b64),
      };
    }
  });

  const key = await withDb(dbName, async (c) => {
    const existing = await c.query(
      'SELECT server_name, pubkey_b64, privkey_enc, key_id FROM tenant WHERE server_name = $1;',
      [dnsName],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0] as Record<string, unknown>;
      if (f0 && String(row.pubkey_b64) !== (f0 as { pubB64: string }).pubB64) {
        throw new Error('E_KEY_MISMATCH: tenant key differs from F0 key — refusing to rotate');
      }
      const pubRaw = b64decode(String(row.pubkey_b64));
      const privDer = b64decode(String(row.privkey_enc));
      return {
        keyId: String(row.key_id),
        serverName: String(row.server_name),
        nativeName: nativeNameFor(pubRaw),
        publicKey: await importPublicKeyFromRaw(pubRaw),
        privateKey: await importPrivateKeyFromPkcs8(privDer),
        publicB64: String(row.pubkey_b64),
      } as TenantKey;
    }
    // No tenant row: migrate the F0 key, or generate fresh.
    let keyId: string;
    let pubB64: string;
    let privB64: string;
    let publicKey: CryptoKey;
    let privateKey: CryptoKey;
    if (f0) {
      const f = f0 as { keyId: string; pubB64: string; privB64: string };
      keyId = f.keyId;
      pubB64 = f.pubB64;
      privB64 = f.privB64;
      publicKey = await importPublicKeyFromRaw(b64decode(pubB64));
      privateKey = await importPrivateKeyFromPkcs8(b64decode(privB64));
    } else {
      const kp = (await generateSigningKeypair()) as unknown as CryptoKeyPair;
      pubB64 = b64encode(await exportPublicKeyRaw(kp.publicKey));
      privB64 = b64encode(await exportPrivateKeyPkcs8(kp.privateKey));
      publicKey = kp.publicKey;
      privateKey = kp.privateKey;
      keyId = '1';
    }
    await c.query(
      'INSERT INTO tenant (server_name, native_name, pubkey_b64, privkey_enc, key_id, created_ms) VALUES ($1, $2, $3, $4, $5, $6);',
      [
        dnsName,
        nativeNameFor(b64decode(pubB64)),
        pubB64,
        privB64,
        keyId,
        Date.now(),
      ],
    );
    return {
      keyId,
      serverName: dnsName,
      nativeName: nativeNameFor(b64decode(pubB64)),
      publicKey,
      privateKey,
      publicB64: pubB64,
    } as TenantKey;
  });
  return { dbName, key };
}

export async function getTenantKey(dnsName = serverName()): Promise<TenantKey> {
  return (await ensureTenant(dnsName)).key;
}

export interface RegisterParams {
  localpart: string;
  password: string;
  deviceId?: string;
  displayName?: string;
  // Fixed token override (dev seeds). null = inhibit_login (no token).
  // undefined = mint a random token.
  accessToken?: string | null;
}

export interface RegisterResult {
  user_id: string;
  access_token?: string;
  device_id: string;
  home_server: string;
}

// The real /register path (endpoint + dev seeds share it). Throws
// MatrixError M_USER_IN_USE (400) for taken localparts.
export async function registerUser(
  serverName: string,
  params: RegisterParams,
): Promise<RegisterResult> {
  const localpart = checkLocalpart(params.localpart);
  if (typeof params.password !== 'string' || params.password.length === 0) {
    throw new MatrixError(400, 'M_BAD_REQUEST', 'password required');
  }
  const { dbName } = await ensureTenant(serverName);
  const deviceId = params.deviceId && params.deviceId.length > 0
    ? params.deviceId
    : crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const result = await withDb(dbName, async (c) => {
    const taken = await c.query('SELECT localpart FROM users WHERE localpart = $1;', [localpart]);
    if (taken.rows.length > 0) {
      throw new MatrixError(400, 'M_USER_IN_USE', 'user in use: ' + localpart);
    }
    const displayName = typeof params.displayName === 'string' && params.displayName.length > 0
      ? params.displayName
      : localpart;
    await c.query('INSERT INTO users (localpart, display_name) VALUES ($1, $2);', [
      localpart,
      displayName,
    ]);
    const phc = hashPassword(params.password);
    await c.query(
      "INSERT INTO credentials (localpart, kind, hash, salt, params) VALUES ($1, 'argon2id', $2, NULL, NULL);",
      [localpart, phc],
    );
    await c.query(
      'INSERT INTO devices (device_id, localpart, display_name) VALUES ($1, $2, $3) ON CONFLICT (device_id) DO UPDATE SET localpart = $2, display_name = $3;',
      [deviceId, localpart, displayName],
    );
    const userId = `@${localpart}:${serverName}`;
    let accessToken: string | undefined;
    if (params.accessToken !== null) {
      accessToken = typeof params.accessToken === 'string' && params.accessToken.length > 0
        ? params.accessToken
        : crypto.randomUUID();
      await c.query(
        'INSERT INTO access_tokens (token, localpart, device_id) VALUES ($1, $2, $3) ON CONFLICT (token) DO NOTHING;',
        [accessToken, localpart, deviceId],
      );
    }
    return {
      user_id: userId,
      access_token: accessToken,
      device_id: deviceId,
      home_server: serverName,
    } as RegisterResult;
  });
  return result;
}

export async function verifyUserPassword(
  serverName: string,
  localpart: string,
  password: string,
): Promise<boolean> {
  const { dbName } = await ensureTenant(serverName);
  return await withDb(dbName, async (c) => {
    const r = await c.query(
      "SELECT hash FROM credentials WHERE localpart = $1 AND kind = 'argon2id';",
      [localpart],
    );
    if (r.rows.length === 0) return false;
    return verifyPassword(String(r.rows[0].hash), password);
  });
}

export interface TokenInfo {
  localpart: string;
  user_id: string;
  device_id: string | null;
}

export async function lookupToken(
  serverName: string,
  token: string,
): Promise<TokenInfo | null> {
  const { dbName } = await ensureTenant(serverName);
  return await withDb(dbName, async (c) => {
    const r = await c.query(
      'SELECT localpart, device_id FROM access_tokens WHERE token = $1;',
      [token],
    );
    if (r.rows.length === 0) return null;
    const localpart = String(r.rows[0].localpart);
    return {
      localpart,
      user_id: `@${localpart}:${serverName}`,
      device_id: r.rows[0].device_id == null ? null : String(r.rows[0].device_id),
    };
  });
}

export async function issueToken(
  serverName: string,
  localpart: string,
  deviceId: string,
): Promise<string> {
  const { dbName } = await ensureTenant(serverName);
  const token = crypto.randomUUID();
  await withDb(dbName, async (c) => {
    await c.query(
      'INSERT INTO access_tokens (token, localpart, device_id) VALUES ($1, $2, $3);',
      [token, localpart, deviceId],
    );
  });
  return token;
}

export async function revokeToken(serverName: string, token: string): Promise<void> {
  const { dbName } = await ensureTenant(serverName);
  await withDb(dbName, async (c) => {
    const r = await c.query('SELECT device_id FROM access_tokens WHERE token = $1;', [token]);
    const deviceId = r.rows.length && r.rows[0].device_id != null
      ? String(r.rows[0].device_id)
      : null;
    await c.query('DELETE FROM access_tokens WHERE token = $1;', [token]);
    // Logging out removes the device too (Synapse semantics — the logout
    // gate asserts the device list shrinks).
    if (deviceId) {
      await c.query('DELETE FROM access_tokens WHERE device_id = $1;', [deviceId]);
      await c.query('DELETE FROM devices WHERE device_id = $1;', [deviceId]);
    }
  });
}

export async function upsertDevice(
  serverName: string,
  localpart: string,
  deviceId: string,
  displayName?: string,
): Promise<void> {
  const { dbName } = await ensureTenant(serverName);
  await withDb(dbName, async (c) => {
    await c.query(
      'INSERT INTO devices (device_id, localpart, display_name) VALUES ($1, $2, $3) ON CONFLICT (device_id) DO UPDATE SET localpart = $2, display_name = COALESCE($3, devices.display_name);',
      [deviceId, localpart, displayName ?? null],
    );
  });
}

export async function listDevices(
  serverName: string,
  localpart: string,
): Promise<{ device_id: string; display_name: string | null }[]> {
  const { dbName } = await ensureTenant(serverName);
  return await withDb(dbName, async (c) => {
    const r = await c.query(
      'SELECT device_id, display_name FROM devices WHERE localpart = $1 ORDER BY device_id;',
      [localpart],
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => ({
      device_id: String(row.device_id),
      display_name: row.display_name == null ? null : String(row.display_name),
    }));
  });
}

export async function revokeAllTokens(serverName: string, localpart: string): Promise<void> {
  const { dbName } = await ensureTenant(serverName);
  await withDb(dbName, async (c) => {
    await c.query('DELETE FROM access_tokens WHERE localpart = $1;', [localpart]);
    await c.query('DELETE FROM devices WHERE localpart = $1;', [localpart]);
  });
}

// --- M2: devices ---------------------------------------------------------

/** One device the localpart owns; null = not found/not owned. */
export async function getDevice(
  serverName: string,
  localpart: string,
  deviceId: string,
): Promise<{ device_id: string; display_name: string | null } | null> {
  const { dbName } = await ensureTenant(serverName);
  return await withDb(dbName, async (c) => {
    const r = await c.query(
      'SELECT device_id, display_name FROM devices WHERE device_id = $1 AND localpart = $2;',
      [deviceId, localpart],
    );
    if (r.rows.length === 0) return null;
    return {
      device_id: String(r.rows[0].device_id),
      display_name: r.rows[0].display_name == null
        ? null
        : String(r.rows[0].display_name),
    };
  });
}

/** Rename a device the localpart owns; false = not owned/not found. */
export async function updateDeviceName(
  serverName: string,
  localpart: string,
  deviceId: string,
  displayName: string,
): Promise<boolean> {
  const { dbName } = await ensureTenant(serverName);
  return await withDb(dbName, async (c) => {
    const r = await c.query(
      'UPDATE devices SET display_name = $1 WHERE device_id = $2 AND localpart = $3;',
      [displayName, deviceId, localpart],
    );
    return r.rowCount > 0;
  });
}

/** Delete the named devices of localpart — their tokens and pushers go
 * with them (a device's tokens' pushers are the user's pushers made by
 * those tokens; deleting the token deletes what it created). */
export async function deleteDevices(
  serverName: string,
  localpart: string,
  deviceIds: string[],
): Promise<void> {
  const { dbName } = await ensureTenant(serverName);
  await withDb(dbName, async (c) => {
    for (const deviceId of deviceIds) {
      await c.query(
        'DELETE FROM pushers WHERE access_token IN (SELECT token FROM access_tokens WHERE device_id = $1 AND localpart = $2);',
        [deviceId, localpart],
      );
      await c.query('DELETE FROM access_tokens WHERE device_id = $1 AND localpart = $2;', [
        deviceId,
        localpart,
      ]);
      await c.query('DELETE FROM devices WHERE device_id = $1 AND localpart = $2;', [
        deviceId,
        localpart,
      ]);
    }
  });
}

// UIA sessions (persisted: a container restart mid-flow degrades to a
// client retry, never to a half-registered user — creation is atomic).
export interface UiaSession {
  session: string;
  flows: { stages: string[] }[];
  completed: string[];
}

export async function createUiaSession(
  serverName: string,
  flows: { stages: string[] }[],
): Promise<UiaSession> {
  const { dbName } = await ensureTenant(serverName);
  const session = crypto.randomUUID().replaceAll('-', '');
  await withDb(dbName, async (c) => {
    await c.query(
      'INSERT INTO uia_sessions (session, flows, completed, created_ms) VALUES ($1, $2, $3, $4);',
      [session, JSON.stringify(flows), '[]', Date.now()],
    );
  });
  return { session, flows, completed: [] };
}

export async function getUiaSession(
  serverName: string,
  session: string,
): Promise<UiaSession | null> {
  const { dbName } = await ensureTenant(serverName);
  return await withDb(dbName, async (c) => {
    const r = await c.query(
      'SELECT flows, completed FROM uia_sessions WHERE session = $1;',
      [session],
    );
    if (r.rows.length === 0) return null;
    const parse = (v: unknown) =>
      typeof v === 'string' ? JSON.parse(v) : (v as unknown);
    return {
      session,
      flows: parse(r.rows[0].flows) as { stages: string[] }[],
      completed: parse(r.rows[0].completed) as string[],
    };
  });
}

export async function completeUiaStages(
  serverName: string,
  session: string,
  stages: string[],
): Promise<UiaSession> {
  const { dbName } = await ensureTenant(serverName);
  return await withDb(dbName, async (c) => {
    const cur = await c.query(
      'SELECT completed FROM uia_sessions WHERE session = $1;',
      [session],
    );
    const parse = (v: unknown): string[] =>
      typeof v === 'string' ? JSON.parse(v) as string[] : (v as string[]);
    const completed = new Set<string>(
      cur.rows.length ? parse(cur.rows[0].completed) : [],
    );
    for (const s of stages) completed.add(s);
    const arr = [...completed];
    await c.query('UPDATE uia_sessions SET completed = $1 WHERE session = $2;', [
      JSON.stringify(arr),
      session,
    ]);
    const f = await c.query('SELECT flows FROM uia_sessions WHERE session = $1;', [session]);
    const flows = typeof f.rows[0].flows === 'string'
      ? JSON.parse(f.rows[0].flows) as { stages: string[] }[]
      : (f.rows[0].flows as { stages: string[] }[]);
    return { session, flows, completed: arr };
  });
}

export async function dropUiaSession(serverName: string, session: string): Promise<void> {
  const { dbName } = await ensureTenant(serverName);
  await withDb(dbName, async (c) => {
    await c.query('DELETE FROM uia_sessions WHERE session = $1;', [session]);
  });
}
