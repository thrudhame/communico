// api/engine/config.ts — TOML defaults, config overlay, COMMUNICO_* env.
// No in-code fallbacks (ruling 8): a missing or mistyped leaf is a
// startup error listing every problem, never a silent default. loadConfig
// is pure given its paths; config() loads lazily from conventional paths
// + Deno.env on first use.
import { parse } from '@std/toml';
import { join } from '@std/path';
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

  const preview = built.preview;
  if (
    preview !== null && typeof preview === 'object' && !Array.isArray(preview)
  ) {
    const p = preview as Record<string, unknown>;
    for (const leaf of ['blocklist', 'allowlist']) {
      const list = p[leaf];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (typeof item !== 'string') continue;
        if (parseCidr(item) === null) {
          problems.push(
            `config: preview.${leaf} (${
              envNameOf(['preview', leaf])
            }): malformed CIDR ${display(item)}`,
          );
        }
      }
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
  server?: { name?: string; port?: number };
  db?: {
    host?: string;
    port?: number;
    user?: string;
    pass?: string;
    name?: string;
  };
  media?: { root?: string; maxbytes?: number };
  preview?: {
    enabled?: boolean;
    maxbytes?: number;
    blocklist?: string[];
    allowlist?: string[];
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
