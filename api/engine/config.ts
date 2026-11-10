// api/engine/config.ts — TOML defaults, config overlay, COMMUNICO_* env.
// No in-code fallbacks (ruling 8): a missing or mistyped leaf is a
// startup error listing every problem, never a silent default. loadConfig
// is pure given its paths; config() loads lazily from conventional paths
// + Deno.env on first use.
import { parse } from '@std/toml';
import { dirname, join, resolve } from '@std/path';
import {
  type Config,
  envNameOf,
  type LeafType,
  leaves,
  nodePathOf,
  SCHEMA,
  type Schema,
} from './config-schema.ts';
import { parseCidr } from './preview/cidr.ts';

export type { Config } from './config-schema.ts';
export { envNameOf, leaves, SCHEMA } from './config-schema.ts';

export type Source = 'defaults' | 'config' | 'env';

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export function resolvePaths(
  cwd: string,
  env: Record<string, string>,
): { defaultsPath: string; configPath: string | null } {
  const defaultsPath = join(cwd, 'defaults/communico.toml');
  if (Object.hasOwn(env, 'COMMUNICO_CONFIG')) {
    return { defaultsPath, configPath: env.COMMUNICO_CONFIG };
  }
  const conventional = join(cwd, 'config/communico.toml');
  try {
    Deno.statSync(conventional);
    return { defaultsPath, configPath: conventional };
  } catch {
    return { defaultsPath, configPath: null };
  }
}

export function coerceEnv(
  type: LeafType,
  raw: string,
): { ok: true; value: unknown } | { ok: false } {
  switch (type) {
    case 'string':
      return { ok: true, value: raw };
    case 'int': {
      if (!/^-?\d+$/.test(raw)) return { ok: false };
      const n = Number(raw);
      if (!Number.isSafeInteger(n)) return { ok: false };
      return { ok: true, value: n };
    }
    case 'bool': {
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      return { ok: false };
    }
    case 'list':
      return {
        ok: true,
        value: raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
      };
  }
}

function tomlTypeOk(type: LeafType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'int':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'bool':
      return typeof value === 'boolean';
    case 'list':
      return Array.isArray(value) &&
        value.every((item) => typeof item === 'string');
  }
}

function display(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(value);
}

function getByPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const p of path) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
      return undefined;
    }
    if (!Object.hasOwn(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function setByPath(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const p = path[i];
    if (!Object.hasOwn(cur, p)) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = value;
}

function resolveSchema(
  schema: Schema,
  parts: string[],
): 'leaf' | 'section' | 'unknown' {
  let cur: LeafType | Schema = schema;
  for (const part of parts) {
    if (typeof cur === 'string') return 'unknown';
    if (!Object.hasOwn(cur, part)) return 'unknown';
    cur = cur[part];
  }
  if (typeof cur === 'string') return 'leaf';
  return 'section';
}

function walkUnknown(
  obj: Record<string, unknown>,
  schema: Schema,
  path: string[],
  fileLabel: string,
  problems: string[],
): void {
  for (const [key, value] of Object.entries(obj)) {
    const next = [...path, key];
    if (!Object.hasOwn(schema, key)) {
      problems.push(
        `config: ${fileLabel}: unknown node ${nodePathOf(next)}`,
      );
      continue;
    }
    const spec = schema[key];
    if (typeof spec === 'string') continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(
        `config: ${fileLabel}: expected table at ${nodePathOf(next)}`,
      );
      continue;
    }
    walkUnknown(
      value as Record<string, unknown>,
      spec,
      next,
      fileLabel,
      problems,
    );
  }
}

function readToml(
  path: string,
): { ok: true; value: Record<string, unknown> } | {
  ok: false;
  kind: 'missing' | 'parse';
  detail: string;
} {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return { ok: false, kind: 'missing', detail: path };
  }
  try {
    const value = parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, kind: 'parse', detail: 'not a table' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (e) {
    return { ok: false, kind: 'parse', detail: String(e) };
  }
}

export function loadConfig(opts: {
  defaultsPath: string;
  configPath: string | null;
  env: Record<string, string>;
}): { config: Config; sources: Record<string, Source> } {
  const problems: string[] = [];
  const { env } = opts;

  const defaultsRead = readToml(opts.defaultsPath);
  let defaultsObj: Record<string, unknown> = {};
  if (defaultsRead.ok) {
    defaultsObj = defaultsRead.value;
  } else if (defaultsRead.kind === 'parse') {
    problems.push(
      `config: ${opts.defaultsPath}: parse error: ${defaultsRead.detail}`,
    );
  }

  let configObj: Record<string, unknown> = {};
  if (opts.configPath !== null) {
    const configRead = readToml(opts.configPath);
    if (configRead.ok) {
      configObj = configRead.value;
    } else if (configRead.kind === 'missing') {
      problems.push(`config: ${opts.configPath}: missing overlay file`);
    } else {
      problems.push(
        `config: ${opts.configPath}: parse error: ${configRead.detail}`,
      );
    }
  }

  if (defaultsRead.ok) {
    walkUnknown(defaultsObj, SCHEMA, [], opts.defaultsPath, problems);
  }
  if (opts.configPath !== null && Object.keys(configObj).length > 0) {
    walkUnknown(configObj, SCHEMA, [], opts.configPath, problems);
  }

  for (const key of Object.keys(env)) {
    if (!key.startsWith('COMMUNICO_')) continue;
    if (key === 'COMMUNICO_CONFIG') continue;
    const rest = key.slice('COMMUNICO_'.length);
    const parts = rest.toLowerCase().split('_');
    if (
      parts.some((p) => p.length === 0 || !/^[a-z0-9]+$/.test(p))
    ) {
      problems.push(`config: ${key}: unknown node ${parts.join('.')}`);
      continue;
    }
    const resolved = resolveSchema(SCHEMA, parts);
    if (resolved === 'unknown') {
      problems.push(`config: ${key}: unknown node ${parts.join('.')}`);
    } else if (resolved === 'section') {
      problems.push(`config: ${key}: names a section, not a value`);
    }
  }

  const built: Record<string, unknown> = {};
  const sources: Record<string, Source> = {};

  for (const [path, type] of leaves(SCHEMA)) {
    const envName = envNameOf(path);
    const node = nodePathOf(path);
    if (Object.hasOwn(env, envName)) {
      const coerced = coerceEnv(type, env[envName]);
      if (!coerced.ok) {
        problems.push(
          `config: ${node} (${envName}): expected ${type}, got ${
            display(env[envName])
          } (from env)`,
        );
        continue;
      }
      setByPath(built, path, coerced.value);
      sources[node] = 'env';
      continue;
    }
    const fromConfig = getByPath(configObj, path);
    if (fromConfig !== undefined) {
      if (!tomlTypeOk(type, fromConfig)) {
        problems.push(
          `config: ${node} (${envName}): expected ${type}, got ${
            display(fromConfig)
          } (from config)`,
        );
        continue;
      }
      setByPath(built, path, fromConfig);
      sources[node] = 'config';
      continue;
    }
    const fromDefaults = getByPath(defaultsObj, path);
    if (fromDefaults !== undefined) {
      if (!tomlTypeOk(type, fromDefaults)) {
        problems.push(
          `config: ${node} (${envName}): expected ${type}, got ${
            display(fromDefaults)
          } (from defaults)`,
        );
        continue;
      }
      setByPath(built, path, fromDefaults);
      sources[node] = 'defaults';
      continue;
    }
    problems.push(
      `config: ${node} (${envName}): missing — add it to defaults/communico.toml`,
    );
  }

  const grace = (built.server as Record<string, unknown> | undefined)
    ?.shutdowngraceseconds;
  if (typeof grace === 'number' && grace < 0) {
    problems.push(
      `config: server.shutdowngraceseconds (COMMUNICO_SERVER_SHUTDOWNGRACESECONDS): expected >= 0, got ${grace}`,
    );
  }

  const requestBytes = (built.server as Record<string, unknown> | undefined)
    ?.maxrequestbytes;
  if (typeof requestBytes === 'number' && requestBytes < 1) {
    problems.push(
      'config: server.maxrequestbytes (COMMUNICO_SERVER_MAXREQUESTBYTES): expected > 0',
    );
  }

  const retention = (built.push as Record<string, unknown> | undefined)
    ?.readretentiondays;
  if (typeof retention === 'number' && retention < 0) {
    problems.push(
      `config: push.readretentiondays (COMMUNICO_PUSH_READRETENTIONDAYS): expected >= 0, got ${retention}`,
    );
  }
  const deliveryHours = (built.push as Record<string, unknown> | undefined)
    ?.deliverygiveuphours;
  if (typeof deliveryHours === 'number' && deliveryHours < 0) {
    problems.push(
      `config: push.deliverygiveuphours (COMMUNICO_PUSH_DELIVERYGIVEUPHOURS): expected >= 0, got ${deliveryHours}`,
    );
  }
  for (
    const [leaf, value] of Object.entries(
      (built.e2ee ?? {}) as Record<string, unknown>,
    )
  ) {
    if (typeof value === 'number' && value < 0) {
      problems.push(
        `config: e2ee.${leaf} (${
          envNameOf(['e2ee', leaf])
        }): expected >= 0, got ${value}`,
      );
    }
  }
  const media = built.media as Record<string, unknown> | undefined;
  if (media) {
    for (
      const leaf of [
        'maxbytes',
        'timeoutms',
        'maxfetches',
        'maxpixels',
        'maxdimension',
        'thumbnailms',
        'thumbnailworkers',
        'maxvariants',
        'cleanupseconds',
      ]
    ) {
      const value = media[leaf];
      if (
        typeof value === 'number' &&
        (!Number.isSafeInteger(value) || value <= 0)
      ) {
        problems.push(
          `config: media.${leaf} (${
            envNameOf(['media', leaf])
          }): expected a positive safe integer`,
        );
      }
    }
    const hops = media.maxredirects;
    if (typeof hops === 'number' && (!Number.isSafeInteger(hops) || hops < 0)) {
      problems.push(
        'config: media.maxredirects (COMMUNICO_MEDIA_MAXREDIRECTS): expected >= 0',
      );
    }
    const cache = media.cache as Record<string, unknown> | undefined;
    for (const [scope, values] of Object.entries(cache ?? {})) {
      const entries = typeof values === 'number'
        ? [[['media', 'cache', scope], values] as const]
        : Object.entries(values as Record<string, unknown>).map((
          [leaf, value],
        ) => [['media', 'cache', scope, leaf], value] as const);
      for (const [path, value] of entries) {
        if (
          typeof value === 'number' &&
          (!Number.isSafeInteger(value) || value < 0)
        ) {
          problems.push(
            `config: ${path.join('.')} (${
              envNameOf([...path])
            }): expected >= 0`,
          );
        }
      }
    }
  }
  for (const section of ['preview', 'push', 'media']) {
    const p = built[section] as Record<string, unknown> | undefined;
    if (!p) continue;
    for (const leaf of ['blocklist', 'allowlist']) {
      const list = p[leaf];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (typeof item !== 'string') continue;
        if (parseCidr(item) === null) {
          problems.push(
            `config: ${section}.${leaf} (${
              envNameOf([section, leaf])
            }): malformed CIDR ${display(item)}`,
          );
        }
      }
    }
  }
  const pushCa = (built.push as Record<string, unknown> | undefined)?.cacerts;
  if (Array.isArray(pushCa)) {
    for (const path of pushCa) {
      if (typeof path !== 'string') continue;
      try {
        Deno.readTextFileSync(path);
      } catch {
        problems.push(
          `config: push.cacerts (COMMUNICO_PUSH_CACERTS): file not readable: ${
            display(path)
          }`,
        );
      }
    }
  }

  const federation = built.federation;
  if (
    federation !== null && typeof federation === 'object' &&
    !Array.isArray(federation)
  ) {
    const f = federation as Record<string, unknown>;
    const envOf = (leaf: string) => envNameOf(['federation', leaf]);
    const enumLeaf = (leaf: string, allowed: string[]) => {
      const v = f[leaf];
      if (typeof v === 'string' && !allowed.includes(v)) {
        problems.push(
          `config: federation.${leaf} (${envOf(leaf)}): expected one of ${
            allowed.join(', ')
          }, got ${display(v)}`,
        );
      }
    };
    enumLeaf('keychange', ['accept', 'warn', 'block']);
    enumLeaf('mode', ['open', 'closed']);
    enumLeaf('lookups', ['all', 'known', 'none']);
    const kvh = f.keyvalidityhours;
    const discoveryServers = f.discoveryservers;
    if (typeof discoveryServers === 'number' && discoveryServers < 1) {
      problems.push(
        'config: federation.discoveryservers (COMMUNICO_FEDERATION_DISCOVERYSERVERS): expected >= 1',
      );
    }
    if (typeof kvh === 'number' && kvh > 168) {
      problems.push(
        `config: federation.keyvalidityhours (${
          envOf('keyvalidityhours')
        }): spec cap is 168 (7 days), got ${kvh}`,
      );
    }
    const witnesses = f.witnesses;
    if (typeof witnesses === 'number' && witnesses < 1) {
      problems.push(
        `config: federation.witnesses (${
          envOf('witnesses')
        }): expected >= 1, got ${witnesses}`,
      );
    }
    // M5b delivery/history family: ordering rules across the leaves and
    // the backoff ceiling's ladder rule (plan §3.1).
    const intLeaf = (leaf: string): number | null => {
      const v = f[leaf];
      return typeof v === 'number' ? v : null;
    };
    for (
      const leaf of [
        'missingwaitms',
        'missinglimit',
        'missingbudgetms',
        'missingmax',
        'backfillbatch',
        'backfillmax',
        'bulkmaxbytes',
        'backoffstartmillihours',
        'backoffmaxmillihours',
        'refusedmillihours',
        'txnhours',
      ]
    ) {
      const v = intLeaf(leaf);
      if (v !== null && v < 1) {
        problems.push(
          `config: federation.${leaf} (${
            envOf(leaf)
          }): expected >= 1, got ${v}`,
        );
      }
    }
    const ungrounded = intLeaf('ungroundedmillihours');
    if (ungrounded !== null && ungrounded < 0) {
      problems.push(
        `config: federation.ungroundedmillihours (${
          envOf('ungroundedmillihours')
        }): expected >= 0, got ${ungrounded}`,
      );
    }
    const missinglimit = intLeaf('missinglimit');
    const missingmax = intLeaf('missingmax');
    if (
      missinglimit !== null && missingmax !== null && missinglimit > missingmax
    ) {
      problems.push(
        `config: federation.missinglimit (${
          envOf('missinglimit')
        }): expected <= federation.missingmax (${missingmax}), got ${missinglimit}`,
      );
    }
    const backfillbatch = intLeaf('backfillbatch');
    const backfillmax = intLeaf('backfillmax');
    if (
      backfillbatch !== null && backfillmax !== null &&
      backfillbatch > backfillmax
    ) {
      problems.push(
        `config: federation.backfillbatch (${
          envOf('backfillbatch')
        }): expected <= federation.backfillmax (${backfillmax}), got ${backfillbatch}`,
      );
    }
    const missingwaitms = intLeaf('missingwaitms');
    const missingbudgetms = intLeaf('missingbudgetms');
    if (
      missingwaitms !== null && missingbudgetms !== null &&
      missingwaitms >= missingbudgetms
    ) {
      problems.push(
        `config: federation.missingwaitms (${
          envOf('missingwaitms')
        }): expected < federation.missingbudgetms (${missingbudgetms}), got ${missingwaitms}`,
      );
    }
    const backoffStart = intLeaf('backoffstartmillihours');
    const backoffMax = intLeaf('backoffmaxmillihours');
    if (
      backoffStart !== null && backoffMax !== null && backoffStart >= 1 &&
      backoffMax >= 1
    ) {
      // the ceiling must be a rung on the ladder: start × 2^k, k >= 0
      const ratio = backoffMax / backoffStart;
      const k = Math.log2(ratio);
      if (!Number.isInteger(ratio) || !Number.isInteger(k) || k < 0) {
        const kLow = Math.max(0, Math.floor(Math.log2(Math.max(ratio, 1e-9))));
        const low = backoffStart * 2 ** kLow;
        const high = backoffStart * 2 ** (kLow + 1);
        problems.push(
          `config: federation.backoffmaxmillihours (${
            envOf('backoffmaxmillihours')
          }): must be backoffstartmillihours × 2^k (${backoffStart} × 2^k) — the neighbouring rungs are ${low} and ${high}, got ${backoffMax}`,
        );
      }
    }
    const cacerts = f.cacerts;
    if (Array.isArray(cacerts)) {
      for (const item of cacerts) {
        if (typeof item !== 'string') continue;
        try {
          Deno.openSync(item, { read: true }).close();
        } catch {
          problems.push(
            `config: federation.cacerts (${
              envOf('cacerts')
            }): file not readable: ${display(item)}`,
          );
        }
      }
    }
  }

  if (
    typeof (built.admin as Record<string, unknown> | undefined)?.socket ===
      'string' &&
    typeof (built.store as Record<string, unknown> | undefined)?.dir ===
      'string'
  ) {
    try {
      adminSocket(built as Config);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return { config: built as Config, sources };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function formatShellExports(config: Config): string {
  const lines: string[] = [];
  for (const [path, type] of leaves(SCHEMA)) {
    const value = getByPath(config, path);
    const rendered = type === 'list'
      ? (value as string[]).join(',')
      : String(value);
    lines.push(`export ${envNameOf(path)}=${shellQuote(rendered)}`);
  }
  return lines.join('\n') + '\n';
}

export type LoadedConfig = {
  config: Config;
  sources: Record<string, Source>;
  defaultsPath: string;
  configPath: string | null;
};

let _loaded: LoadedConfig | undefined;
let _base: Config | undefined;

function ensureLoaded(): LoadedConfig {
  if (_loaded) return _loaded;
  const env = Deno.env.toObject();
  const { defaultsPath, configPath } = resolvePaths(Deno.cwd(), env);
  const { config, sources } = loadConfig({ defaultsPath, configPath, env });
  _base = structuredClone(config);
  _loaded = { config, sources, defaultsPath, configPath };
  return _loaded;
}

/** Memoized accessor. Pure tests that only call loadConfig never hit this. */
export function config(): Config {
  return ensureLoaded().config;
}

export function loadedConfig(): LoadedConfig {
  return ensureLoaded();
}

export type ConfigPatch = {
  push?: {
    readretentiondays?: number;
    deliverygiveuphours?: number;
    blocklist?: string[];
    allowlist?: string[];
    cacerts?: string[];
  };
  server?: {
    name?: string;
    port?: number;
    shutdowngraceseconds?: number;
    maxrequestbytes?: number;
  };
  admin?: { socket?: string };
  media?: Partial<Omit<Config['media'], 'cache'>> & {
    cache?: {
      maxbytes?: number;
      remote?: Partial<Config['media']['cache']['remote']>;
      thumbnail?: Partial<Config['media']['cache']['thumbnail']>;
    };
  };
  encryption?: {
    allowunencryptedcreation?: boolean;
    allowunencryptedjoining?: boolean;
    allowunencryptedmessages?: boolean;
  };
  e2ee?: {
    maxrequestbytes?: number;
    maxkeybytes?: number;
    maxkeys?: number;
    maxonetimekeys?: number;
    maxinboxmessages?: number;
    maxdestinationmessages?: number;
    maxbackupsessions?: number;
    maxbackupversions?: number;
    maxbackupbytes?: number;
  };
  preview?: {
    enabled?: boolean;
    maxbytes?: number;
    blocklist?: string[];
    allowlist?: string[];
  };
  federation?: {
    enabled?: boolean;
    port?: number;
    cert?: string;
    key?: string;
    cacerts?: string[];
    keyvalidityhours?: number;
    keychange?: string;
    mode?: string;
    wellknown?: string;
    wellknownmaxage?: number;
    connectms?: number;
    timeoutms?: number;
    maxbytes?: number;
    wellknownhours?: number;
    wellknownmaxhours?: number;
    wellknownerrorhours?: number;
    keyfailminutes?: number;
    witnesses?: number;
    pendingmax?: number;
    pendingdays?: number;
    lookups?: string;
    missingwaitms?: number;
    missinglimit?: number;
    missingbudgetms?: number;
    missingmax?: number;
    backfillbatch?: number;
    backfillmax?: number;
    bulkmaxbytes?: number;
    backoffstartmillihours?: number;
    backoffmaxmillihours?: number;
    refusedmillihours?: number;
    ungroundedmillihours?: number;
    txnhours?: number;
  };
};

/** Deep-merge over the originally loaded config. Legal under tests/ only. */
export function setConfigForTests(partial: ConfigPatch): void {
  ensureLoaded();
  const merged = structuredClone(_base) as Record<string, unknown>;
  for (const [path] of leaves(SCHEMA)) {
    const value = getByPath(partial, path);
    if (value !== undefined) setByPath(merged, path, value);
  }
  _loaded = { ..._loaded!, config: merged as Config };
}

/** The homeserver's DNS name (single source since M0). */
export function serverName(): string {
  return config().server.name;
}

/** The one listener's port. */
export function appPort(): number {
  return config().server.port;
}

/** Shared by the listener and operator clients; never opens the store. */
export function adminSocket(c: Config = config()): string {
  return validateAdminSocketPath(
    c.admin.socket === ''
      ? join(dirname(resolve(c.store.dir)), 'admin.sock')
      : c.admin.socket,
  );
}

/** Linux sun_path reserves one of its 108 bytes for the terminating NUL. */
export function validateAdminSocketPath(value: string): string {
  const path = resolve(value);
  const length = new TextEncoder().encode(path).length;
  if (length > 107) {
    throw new Error(
      `admin socket path exceeds 107 bytes: ${path} (${length} bytes)`,
    );
  }
  return path;
}
