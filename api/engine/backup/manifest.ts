// Portable bundle metadata and its exact, non-symlink payload inventory. This
// layer never loads native storage or opens/migrates an archived database.
import { createHash } from 'node:crypto';
import { basename, dirname, join, parse, resolve } from '@std/path';
import type { BuildInfo } from '#engine/store/build.ts';
import { syncPath, syncTree } from '#engine/store/files.ts';

type Kind = 'server' | 'rooms' | 'tenants';
type Digest = { path: string; size: number; sha256: string };
export type Payload = Digest & { stored: Digest };
export type Manifest = {
  format: 1;
  backupId: string;
  serverName: string;
  applicationVersion: string;
  native: BuildInfo;
  cut: { startedAt: string; endedAt: string; pauseMs: number };
  encryption: 'none' | 'openpgp-aes256';
  contains_signing_private_keys: true;
  contains_password_hashes: true;
  tenants: {
    id: string;
    nativeName: string;
    keyId: string;
    publicKey: string;
    fingerprint: string;
  }[];
  databases: {
    kind: Kind;
    id: string | null;
    path: string;
    schemaVersion: number;
    heads: Record<string, number>;
  }[];
  media: { tenant: string; id: string; path: string }[];
  deployment: { node: string; source: string; path: string }[];
  configuration: {
    overlay: string | null;
    sources: Record<string, 'defaults' | 'config' | 'env'>;
    externalSecrets: string[];
  };
  exclusions: string[];
  payloads: Payload[];
};

function fail(message: string): never {
  throw new Error('backup manifest: ' + message);
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('expected object');
  }
  return value as Record<string, unknown>;
}
function shape(value: unknown, keys: string[]): Record<string, unknown> {
  const row = object(value);
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(row, key))
  ) fail('unexpected or missing fields');
  return row;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('expected nonempty string');
  }
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('expected nonnegative safe integer');
  }
  return value;
}
function array<T>(value: unknown, decode: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) fail('expected array');
  return value.map(decode);
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) fail('unsupported value');
  return value as T;
}
function unique(values: string[], what: string): void {
  if (new Set(values).size !== values.length) fail('duplicate ' + what);
}
function hash(value: unknown): string {
  const result = text(value);
  if (!/^[a-f0-9]{64}$/.test(result)) fail('invalid SHA256');
  return result;
}
function relative(value: unknown): string {
  const path = text(value);
  if (
    path.includes('\\') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) fail('invalid relative path');
  return path;
}
function payloadPath(value: unknown, encrypted = false): string {
  const path = relative(value);
  const plain = encrypted && path.endsWith('.gpg') ? path.slice(0, -4) : path;
  if (
    !/^(?:store\/(?:server|(?:rooms|tenants)\/[a-f0-9]{32})\/data\.db|media\/[A-Za-z0-9_-]+|deployment\/[A-Za-z0-9_.-]+)$/
      .test(plain)
  ) fail('unsupported payload path');
  return path;
}
function digest(value: unknown): Digest {
  const row = shape(value, ['path', 'size', 'sha256']);
  return {
    path: payloadPath(row.path, true),
    size: integer(row.size),
    sha256: hash(row.sha256),
  };
}
function timestamp(value: unknown): string {
  const result = text(value);
  if (
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString() !== result
  ) fail('invalid timestamp');
  return result;
}

export function decodeManifest(value: unknown): Manifest {
  const row = shape(value, [
    'format',
    'backupId',
    'serverName',
    'applicationVersion',
    'native',
    'cut',
    'encryption',
    'contains_signing_private_keys',
    'contains_password_hashes',
    'tenants',
    'databases',
    'media',
    'deployment',
    'configuration',
    'exclusions',
    'payloads',
  ]);
  if (row.format !== 1) fail('unsupported format');
  if (
    row.contains_signing_private_keys !== true ||
    row.contains_password_hashes !== true
  ) fail('secret disclosure flags are required');
  const backupId = text(row.backupId);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      backupId,
    )
  ) fail('invalid backup ID');
  const native = shape(row.native, [
    'turso_version',
    'turso_rev',
    'patches',
    'default_features',
    'features',
  ]);
  if (typeof native.default_features !== 'boolean') {
    fail('invalid native features');
  }
  const cut = shape(row.cut, ['startedAt', 'endedAt', 'pauseMs']);
  const startedAt = timestamp(cut.startedAt), endedAt = timestamp(cut.endedAt);
  if (Date.parse(endedAt) < Date.parse(startedAt)) {
    fail('reversed cut interval');
  }
  if (
    typeof cut.pauseMs !== 'number' || !Number.isFinite(cut.pauseMs) ||
    cut.pauseMs < 0
  ) fail('invalid pause measurement');
  const encryption = oneOf(row.encryption, ['none', 'openpgp-aes256']);
  const tenants = array(row.tenants, (value) => {
    const t = shape(value, [
      'id',
      'nativeName',
      'keyId',
      'publicKey',
      'fingerprint',
    ]);
    return {
      id: text(t.id),
      nativeName: text(t.nativeName),
      keyId: text(t.keyId),
      publicKey: text(t.publicKey),
      fingerprint: hash(t.fingerprint),
    };
  });
  unique(tenants.map((tenant) => tenant.id), 'tenant');
  const serverName = text(row.serverName);
  if (!tenants.some((tenant) => tenant.id === serverName)) {
    fail('configured server identity is missing');
  }
  const databases = array(row.databases, (value) => {
    const db = shape(value, ['kind', 'id', 'path', 'schemaVersion', 'heads']);
    const kind = oneOf(db.kind, ['server', 'rooms', 'tenants']);
    const id = db.id === null ? null : text(db.id);
    if ((kind === 'server') !== (id === null)) {
      fail('invalid database identity');
    }
    const path = payloadPath(db.path);
    const expected = kind === 'server'
      ? /^store\/server\/data\.db$/
      : new RegExp('^store/' + kind + '/[a-f0-9]{32}/data\\.db$');
    if (!expected.test(path)) fail('database kind/path mismatch');
    const heads = Object.fromEntries(
      Object.entries(object(db.heads)).map((
        [key, value],
      ) => [text(key), integer(value)]),
    );
    return { kind, id, path, schemaVersion: integer(db.schemaVersion), heads };
  });
  unique(databases.map((db) => db.path), 'database path');
  unique(databases.map((db) => db.kind + ':' + db.id), 'database identity');
  if (databases.filter((db) => db.kind === 'server').length !== 1) {
    fail('exactly one server database is required');
  }
  const tenantIds = databases.filter((db) => db.kind === 'tenants').map((db) =>
    db.id!
  );
  if (
    tenantIds.length !== tenants.length ||
    tenants.some((tenant) => !tenantIds.includes(tenant.id))
  ) fail('tenant database inventory mismatch');
  const media = array(row.media, (value) => {
    const m = shape(value, ['tenant', 'id', 'path']);
    const tenant = text(m.tenant), id = text(m.id), path = payloadPath(m.path);
    if (
      !tenants.some((t) => t.id === tenant) || !/^[A-Za-z0-9_-]+$/.test(id) ||
      path !== 'media/' + id
    ) fail('invalid media identity');
    return { tenant, id, path };
  });
  unique(media.map((m) => JSON.stringify([m.tenant, m.id])), 'media identity');
  const deployment = array(row.deployment, (value) => {
    const file = shape(value, ['node', 'source', 'path']);
    const path = payloadPath(file.path);
    if (!path.startsWith('deployment/')) fail('invalid deployment path');
    return { node: text(file.node), source: text(file.source), path };
  });
  unique(deployment.map((file) => file.path), 'deployment path');
  const configuration = shape(row.configuration, [
    'overlay',
    'sources',
    'externalSecrets',
  ]);
  const overlay = configuration.overlay === null
    ? null
    : payloadPath(configuration.overlay);
  if (overlay !== null && !deployment.some((file) => file.path === overlay)) {
    fail('overlay is not in deployment inventory');
  }
  const sources = Object.fromEntries(
    Object.entries(object(configuration.sources)).map((
      [node, source],
    ) => [text(node), oneOf(source, ['defaults', 'config', 'env'])]),
  );
  const externalSecrets = array(configuration.externalSecrets, (value) => {
    const name = text(value);
    if (!/^COMMUNICO_[A-Z0-9]+(?:_[A-Z0-9]+)*$/.test(name)) {
      fail('invalid external secret name');
    }
    return name;
  });
  unique(externalSecrets, 'external secret name');
  const payloads = array(row.payloads, (value) => {
    const file = shape(value, ['path', 'size', 'sha256', 'stored']);
    const path = payloadPath(file.path);
    const stored = digest(file.stored);
    const size = integer(file.size), sha256 = hash(file.sha256);
    if (stored.path !== path + (encryption === 'none' ? '' : '.gpg')) {
      fail('encryption/path mismatch');
    }
    if (
      encryption === 'none' &&
      (stored.size !== size || stored.sha256 !== sha256)
    ) fail('plaintext digest mismatch');
    return { path, size, sha256, stored };
  });
  unique(payloads.map((file) => file.path), 'payload path');
  unique(payloads.map((file) => file.stored.path), 'stored path');
  const expected = new Set(
    [...databases, ...media, ...deployment].map((file) => file.path),
  );
  if (
    payloads.length !== expected.size ||
    payloads.some((file) => !expected.has(file.path))
  ) fail('payload inventory mismatch');
  const exclusions = array(row.exclusions, text);
  unique(exclusions, 'exclusion');
  return {
    format: 1,
    backupId,
    serverName,
    applicationVersion: text(row.applicationVersion),
    native: {
      turso_version: text(native.turso_version),
      turso_rev: text(native.turso_rev),
      patches: array(native.patches, text),
      default_features: native.default_features,
      features: array(native.features, text),
    },
    cut: { startedAt, endedAt, pauseMs: cut.pauseMs },
    encryption,
    contains_signing_private_keys: true,
    contains_password_hashes: true,
    tenants,
    databases,
    media,
    deployment,
    configuration: { overlay, sources, externalSecrets },
    exclusions,
    payloads,
  };
}

export function assertCompatible(
  manifest: Manifest,
  versions: Record<Kind, number>,
): void {
  for (const db of manifest.databases) {
    if (db.schemaVersion > versions[db.kind]) {
      fail('newer schema for ' + db.path);
    }
  }
}

async function rootDirectory(root: string): Promise<string> {
  const full = resolve(root);
  let path = parse(full).root;
  for (const part of full.slice(path.length).split('/').filter(Boolean)) {
    path = join(path, part);
    const stat = await Deno.lstat(path);
    if (stat.isSymlink) fail('symlink in bundle root');
    if (!stat.isDirectory) fail('bundle root is not a directory');
  }
  return full;
}

// Streaming digests keep inventory memory independent of database/media size.
export async function describePayload(
  root: string,
  path: string,
): Promise<Payload> {
  relative(path);
  const parent = await rootDirectory(join(root, dirname(path)));
  const full = join(parent, basename(path));
  const stat = await Deno.lstat(full);
  if (!stat.isFile) fail('payload is not a regular file');
  const file = await Deno.open(full, { read: true });
  let size = 0;
  const sha = createHash('sha256');
  try {
    const opened = await file.stat();
    if (!opened.isFile || stat.ino !== opened.ino || stat.dev !== opened.dev) {
      fail('payload changed while opening');
    }
    const chunk = new Uint8Array(65536);
    for (;;) {
      const count = await file.read(chunk);
      if (count === null) break;
      size += count;
      sha.update(chunk.subarray(0, count));
    }
    if (size !== stat.size) fail('payload size changed while reading');
  } finally {
    file.close();
  }
  const result = { path, size, sha256: sha.digest('hex') };
  return { ...result, stored: { ...result } };
}

async function verifyInventory(
  root: string,
  manifest: Manifest,
  sealed: boolean,
): Promise<void> {
  root = await rootDirectory(root);
  const expected = new Map(
    manifest.payloads.map((file) => [file.stored.path, file.stored]),
  );
  const directories = new Set<string>();
  for (const path of expected.keys()) {
    for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
      directories.add(parent);
    }
  }
  const found = new Set<string>();
  async function walk(path: string) {
    for await (const entry of Deno.readDir(join(root, path))) {
      const relative = path === '' ? entry.name : path + '/' + entry.name;
      const stat = await Deno.lstat(join(root, relative));
      if (stat.isDirectory) {
        if (!directories.has(relative)) {
          fail('unexpected directory in inventory');
        }
        await walk(relative);
      } else if (!stat.isFile) {
        fail('inventory contains a non-regular entry');
      } else if (sealed && relative === 'manifest.json') {
        continue;
      } else {
        const record = expected.get(relative);
        if (!record) fail('unexpected file in inventory');
        if (stat.size !== record.size) {
          fail('payload size mismatch: ' + relative);
        }
        const actual = await describePayload(root, relative);
        if (actual.sha256 !== record.sha256) {
          fail('payload hash mismatch: ' + relative);
        }
        found.add(relative);
      }
    }
  }
  await walk('');
  if (found.size !== expected.size) fail('missing payload in inventory');
}

export async function sealManifest(
  root: string,
  value: Manifest,
): Promise<void> {
  const manifest = decodeManifest(value);
  // Existing completion is never replaced, even if its bytes are malformed.
  try {
    await Deno.lstat(join(root, 'manifest.json'));
    throw new Deno.errors.AlreadyExists('backup manifest already exists');
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await verifyInventory(root, manifest, false);
  await syncTree(root);
  const file = await Deno.open(join(root, 'manifest.json'), {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(manifest) + '\n');
    let offset = 0;
    while (offset < bytes.length) {
      const count = await file.write(bytes.subarray(offset));
      if (count <= 0) fail('short manifest write');
      offset += count;
    }
    await file.sync();
  } finally {
    file.close();
  }
  await syncPath(root);
}

export async function readManifest(root: string): Promise<Manifest> {
  root = await rootDirectory(root);
  const stat = await Deno.lstat(join(root, 'manifest.json'));
  if (!stat.isFile) fail('manifest is not a regular file');
  const manifest = decodeManifest(
    JSON.parse(await Deno.readTextFile(join(root, 'manifest.json'))),
  );
  await verifyInventory(root, manifest, true);
  return manifest;
}
