// The running store is the backup owner. A bundle is not visible/usable until
// every payload passes captured-data audits and the manifest-last seal fsyncs.
import { basename, dirname, join, relative, resolve } from '@std/path';
import { stringify } from '@std/toml';
import { envNameOf, type LoadedConfig, loadedConfig } from '#engine/config.ts';
import type { Store } from '#engine/store/index.ts';
import {
  copyPrivate,
  copyPrivateFile,
  removeOwned,
} from '#engine/store/files.ts';
import { auditSnapshot } from './audit.ts';
import { openCipher, type PayloadCipher } from './encryption.ts';
import {
  describePayload,
  type Manifest,
  type Payload,
  rootDirectory,
  sealManifest,
} from './manifest.ts';
import metadata from '#root/deno.json' with { type: 'json' };

function overlaps(a: string, b: string): boolean {
  const inside = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === '' || (path !== '..' && !path.startsWith('../'));
  };
  return inside(a, b) || inside(b, a);
}

async function absentDestination(path: string): Promise<void> {
  try {
    await Deno.lstat(path);
    throw new Deno.errors.AlreadyExists('backup destination already exists');
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

// A media root need not exist before the first upload, but every existing
// ancestor must be ordinary. This also prevents hidden overlap through aliases.
async function ordinaryAncestors(path: string): Promise<void> {
  try {
    await rootDirectory(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    await ordinaryAncestors(dirname(path));
  }
}

export async function createBackup(
  store: Store,
  destination: string,
  settings: LoadedConfig = loadedConfig(),
): Promise<{ path: string; manifest: Manifest }> {
  destination = resolve(destination);
  await rootDirectory(dirname(destination));
  await absentDestination(destination);
  const mediaRoot = resolve(settings.config.media.root);
  await ordinaryAncestors(mediaRoot);
  if (
    overlaps(destination, store.directory) || overlaps(destination, mediaRoot)
  ) {
    throw new Error('backup destination overlaps live data');
  }
  const stage = await Deno.makeTempDir({
    dir: dirname(destination),
    prefix: '.communico-backup-',
    suffix: '.new',
  });
  let cipher: PayloadCipher | null = null;
  try {
    cipher = await openCipher(settings.config.backup, stage);
    // Enrollment input can be consumed after its durable grant commits. Capture
    // deployment inputs before the database cut, not after that consumption.
    const deployment = await captureDeployment(stage, settings, cipher);
    const startedAt = new Date().toISOString();
    const cut = await store.snapshot(join(stage, 'store'));
    const endedAt = new Date().toISOString();
    const inventory = await auditSnapshot(
      settings.config.store,
      join(stage, 'store'),
      cut.files,
      settings.config.server.name,
      stage,
    );
    await Deno.mkdir(join(stage, 'media'), { mode: 0o700 });
    const media: Manifest['media'] = [];
    const copiedMedia = new Map<string, number>();
    for (const item of inventory.media) {
      const target = join(stage, item.path);
      const existing = copiedMedia.get(item.path);
      if (existing === undefined) {
        await rootDirectory(mediaRoot);
        await copyPrivate(join(mediaRoot, item.id), target);
        if ((await Deno.stat(target)).size !== item.size) {
          throw new Error('backup local media size mismatch');
        }
        copiedMedia.set(item.path, item.size);
      } else if (existing !== item.size) {
        throw new Error('backup local media identity collision');
      }
      media.push({ tenant: item.tenant, id: item.id, path: item.path });
    }
    // No empty directories survive the exact manifest inventory.
    if (!media.length) await Deno.remove(join(stage, 'media'));
    const manifest: Manifest = {
      format: 1,
      backupId: crypto.randomUUID(),
      serverName: settings.config.server.name,
      applicationVersion: metadata.version,
      native: cut.native,
      cut: { startedAt, endedAt, pauseMs: cut.pauseMs },
      encryption: cipher === null ? 'none' : 'openpgp-aes256',
      contains_signing_private_keys: true,
      contains_password_hashes: true,
      tenants: inventory.tenants,
      databases: inventory.databases,
      media,
      deployment: deployment.files,
      configuration: {
        overlay: deployment.overlay,
        sources: { ...settings.sources },
        externalSecrets: deployment.externalSecrets,
      },
      exclusions: [
        'remote-media-cache',
        'generated-thumbnails',
        'pending-media',
        'orphan-media',
        'runtime-sockets-and-sidecars',
        'backup-passphrase-source',
      ],
      payloads: [],
    };
    const paths = new Set(
      [...manifest.databases, ...manifest.media, ...manifest.deployment].map((
        p,
      ) => p.path),
    );
    for (const path of paths) {
      let payload: Payload = await describePayload(stage, path);
      if (cipher !== null) {
        payload = await cipher.encrypt(stage, payload);
        await Deno.remove(join(stage, path));
      }
      manifest.payloads.push(payload);
    }
    await cipher?.close();
    cipher = null;
    await sealManifest(stage, manifest);
    await store.publishSnapshot(stage, destination);
    return { path: destination, manifest };
  } finally {
    try {
      await cipher?.close();
    } finally {
      await removeOwned(stage);
    }
  }
}

async function captureDeployment(
  root: string,
  settings: LoadedConfig,
  cipher: PayloadCipher | null,
) {
  await Deno.mkdir(join(root, 'deployment'), { mode: 0o700 });
  const files: Manifest['deployment'] = [];
  const externalSecrets: string[] = [];
  const effective = {
    ...structuredClone(settings.config),
    backup: { ...settings.config.backup, passphrasefile: '' },
  };
  // Environment credential values remain independently supplied deployment
  // secrets. Only known config leaves are copied; never serialize Deno.env.
  for (const leaf of ['secret', 'password'] as const) {
    if (settings.sources['turn.' + leaf] === 'env') {
      delete (effective.turn as Partial<typeof effective.turn>)[leaf];
      externalSecrets.push(envNameOf(['turn', leaf]));
    }
  }
  const configuredPassphrase = settings.config.backup.passphrasefile;
  let passphrase: Deno.FileInfo | null = null;
  if (configuredPassphrase !== '') {
    try {
      passphrase = await Deno.lstat(configuredPassphrase);
    } catch (error) {
      if (
        !(error instanceof Deno.errors.NotFound) ||
        settings.config.backup.encrypt
      ) throw error;
    }
  }
  async function copy(
    node: string,
    source: string,
    name: string,
  ): Promise<string> {
    source = resolve(source);
    await rootDirectory(dirname(source));
    const path = 'deployment/' + basename(name);
    await copyPrivateFile(source, join(root, path), (stat) => {
      if (
        (node === 'facade.linkkey' || node === 'facade.pairfile') &&
        (stat.uid !== Deno.uid() || stat.mode === null ||
          (stat.mode & 0o077) !== 0)
      ) {
        throw new Error(
          'backup protected deployment source must be private and owned by this user',
        );
      }
      if (
        cipher?.isPassphraseSource(stat) ||
        (passphrase !== null && stat.dev === passphrase.dev &&
          stat.ino === passphrase.ino)
      ) {
        throw new Error('backup deployment source is the excluded passphrase');
      }
    });
    files.push({ node, source, path });
    return path;
  }
  const overlay = settings.configPath === null
    ? null
    : await copy('config.overlay', settings.configPath, 'operator.toml');
  const f = settings.config.federation;
  for (const leaf of ['cert', 'key'] as const) {
    if (f[leaf] === '') continue;
    try {
      await copy('federation.' + leaf, f[leaf], 'federation-' + leaf + '.pem');
    } catch (error) {
      if (
        !(error instanceof Deno.errors.NotFound) || f.enabled ||
        settings.sources['federation.' + leaf] !== 'defaults'
      ) throw error;
    }
  }
  for (const section of ['federation', 'push'] as const) {
    for (const [index, path] of settings.config[section].cacerts.entries()) {
      await copy(
        section + '.cacerts.' + index,
        path,
        section + '-ca-' + index + '.pem',
      );
    }
  }
  const facade = settings.config.facade;
  for (const leaf of ['linkcert', 'linkkey'] as const) {
    if (facade[leaf] === '') continue;
    await copy('facade.' + leaf, facade[leaf], 'facade-' + leaf + '.pem');
  }
  for (const [index, path] of facade.linkcacerts.entries()) {
    await copy(
      'facade.linkcacerts.' + index,
      path,
      'facade-ca-' + index + '.pem',
    );
  }
  if (facade.pairfile !== '') {
    try {
      await copy('facade.pairfile', facade.pairfile, 'facade-pairing.json');
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const path = 'deployment/effective.toml';
  await Deno.writeTextFile(join(root, path), stringify(effective), {
    createNew: true,
    mode: 0o600,
  });
  files.push({
    node: 'config.effective',
    source: 'layered configuration (external secrets omitted)',
    path,
  });
  return { files, overlay, externalSecrets };
}
