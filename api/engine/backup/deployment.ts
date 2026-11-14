// Re-home archived deployment paths without changing the logical Matrix name.
import { basename, join, resolve } from '@std/path';
import { parse, stringify } from '@std/toml';
import {
  adminSocket,
  envNameOf,
  leaves,
  loadConfig,
  type LoadedConfig,
  SCHEMA,
} from '#engine/config.ts';
import type { Manifest } from './manifest.ts';

function readNode(root: unknown, path: string[]): unknown {
  let value = root;
  for (const part of path) value = (value as Record<string, unknown>)[part];
  return value;
}
function writeNode(
  root: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  let node = root;
  for (const part of path.slice(0, -1)) {
    // New schema sections may not exist in an older effective configuration.
    // Add only the structure needed by an explicitly supplied current leaf;
    // shipped defaults still own every unspecified value.
    if (node[part] === undefined) node[part] = {};
    if (node[part] === null || typeof node[part] !== 'object') {
      throw new Error('invalid archived configuration structure');
    }
    node = node[part] as Record<string, unknown>;
  }
  node[path.at(-1)!] = value;
}

export async function restoreDeployment(
  manifest: Manifest,
  directory: string,
  finalRoot: string,
  finalMedia: string,
  settings: LoadedConfig,
) {
  const effective = manifest.deployment.filter((file) =>
    file.node === 'config.effective'
  );
  if (effective.length !== 1) {
    throw new Error('restore requires exactly one effective configuration');
  }
  const config = parse(
    await Deno.readTextFile(join(directory, basename(effective[0].path))),
  );
  if (
    settings.sources['server.name'] !== 'defaults' &&
    settings.config.server.name !== manifest.serverName
  ) throw new Error('restore cannot change the logical server identity');
  // A target's explicitly supplied overlay/environment values win over archived
  // values; otherwise preserve the captured effective configuration.
  for (const [path] of leaves(SCHEMA)) {
    if (settings.sources[path.join('.')] !== 'defaults') {
      writeNode(config, path, readNode(settings.config, path));
    }
  }
  writeNode(config, ['server', 'name'], manifest.serverName);
  writeNode(config, ['store', 'dir'], finalRoot);
  writeNode(
    config,
    ['store', 'library'],
    resolve(settings.config.store.library),
  );
  writeNode(config, ['media', 'root'], finalMedia);
  writeNode(
    config,
    ['admin', 'socket'],
    adminSocket({
      ...settings.config,
      store: { ...settings.config.store, dir: finalRoot },
    }),
  );
  writeNode(
    config,
    ['backup', 'passphrasefile'],
    settings.config.backup.passphrasefile,
  );
  const externalSecrets = new Set(manifest.configuration.externalSecrets);
  for (const leaf of ['secret', 'password']) {
    const name = envNameOf(['turn', leaf]);
    const source = settings.sources['turn.' + leaf];
    if (source === 'env') externalSecrets.add(name);
    else if (source === 'config') externalSecrets.delete(name);
    if (externalSecrets.has(name)) {
      delete (config.turn as Record<string, unknown>)[leaf];
    }
  }
  const validation = structuredClone(config);
  const mapped = new Set<string>();
  for (const file of manifest.deployment) {
    if (mapped.has(file.node)) {
      throw new Error('duplicate deployment config node');
    }
    mapped.add(file.node);
    if (file.node === 'config.overlay' || file.node === 'config.effective') {
      continue;
    }
    if (
      !/^(?:federation\.(?:cert|key)|(?:federation|push)\.cacerts\.[0-9]+|facade\.(?:linkcert|linkkey|pairfile|linkcacerts\.[0-9]+))$/
        .test(file.node)
    ) throw new Error('unsupported deployment config node');
    const parts = file.node.split('.');
    const leaf = parts.slice(0, 2).join('.');
    if (settings.sources[leaf] !== 'defaults') continue;
    writeNode(
      config,
      parts,
      join(finalRoot, 'deployment', basename(file.path)),
    );
    writeNode(validation, parts, join(directory, basename(file.path)));
  }
  // CA readability is checked against private candidate paths, never nonexistent
  // final paths. Only the final, portable configuration is retained.
  const validatePath = join(directory, '.validate.toml');
  await Deno.writeTextFile(validatePath, stringify(validation), {
    createNew: true,
    mode: 0o600,
  });
  try {
    loadConfig({
      defaultsPath: settings.defaultsPath,
      configPath: validatePath,
      env: {},
    });
  } finally {
    await Deno.remove(validatePath);
  }
  const path = join(directory, 'communico.toml');
  await Deno.writeTextFile(path, stringify(config), {
    createNew: true,
    mode: 0o600,
  });
  return {
    path: join(finalRoot, 'deployment', 'communico.toml'),
    externalSecrets: [...externalSecrets],
  };
}
