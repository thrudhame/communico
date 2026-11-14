import { basename, dirname, join, resolve } from '@std/path';
import { type LoadedConfig, loadedConfig } from '#engine/config.ts';
import { withRestoreTarget } from '#engine/store/restore.ts';
import { withCandidateStore } from '#engine/store/candidate.ts';
import { copyPrivate, removeOwned } from '#engine/store/files.ts';
import { checkBuildInfo } from '#engine/store/build.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { sanitizeRestoredTenant } from '#engine/tenant/restore.ts';
import { rebaseRestoredDeviceStreams } from '#engine/tenant/changes.ts';
import { invalidateRestoredDeviceCaches } from '#engine/server/remote-devices.ts';
import { beginRecovery } from '#engine/server/recovery.ts';
import { auditSnapshot } from './audit.ts';
import {
  assertCompatible,
  describePayload,
  readManifest,
  rootDirectory,
} from './manifest.ts';
import { openCipher } from './encryption.ts';
import { type RestoreReport, writeRestoreReport } from './report.ts';
import { inventoryRestoredWork, restoreWarnings } from './work.ts';
import { restoreDeployment } from './deployment.ts';

export type RestoreResult = {
  path: string;
  media: string;
  configPath: string;
  reportPath: string;
  report: RestoreReport;
  replaced: { store: string | null; media: string | null };
};

export async function restoreBackup(
  bundle: string,
  options: { replace?: boolean } = {},
  settings: LoadedConfig = loadedConfig(),
): Promise<RestoreResult> {
  bundle = await rootDirectory(bundle);
  const storeRoot = resolve(settings.config.store.dir),
    mediaRoot = resolve(settings.config.media.root);
  for (const path of [storeRoot, mediaRoot]) {
    if (
      path === bundle || path.startsWith(bundle + '/') ||
      bundle.startsWith(path + '/')
    ) throw new Error('restore archive and target roots overlap');
  }
  const manifest = await readManifest(bundle);
  checkBuildInfo(manifest.native);
  assertCompatible(manifest, {
    rooms: roomSchema.version,
    tenants: tenantSchema.version,
    server: serverSchema.version,
  });
  return await withRestoreTarget(
    settings.config.store,
    mediaRoot,
    options,
    async (target) => {
      const unpack = await Deno.makeTempDir({
        dir: target.store,
        prefix: '.unpack-',
      });
      const cipher = await openCipher({
        ...settings.config.backup,
        encrypt: manifest.encryption !== 'none',
      }, unpack);
      try {
        for (const payload of manifest.payloads) {
          const destination = join(unpack, payload.path);
          await Deno.mkdir(dirname(destination), {
            recursive: true,
            mode: 0o700,
          });
          if (cipher) await cipher.decrypt(bundle, payload, unpack);
          else {
            await copyPrivate(join(bundle, payload.path), destination);
            const copied = await describePayload(unpack, payload.path);
            if (
              copied.sha256 !== payload.sha256 || copied.size !== payload.size
            ) throw new Error('restore plaintext digest mismatch');
          }
        }
      } finally {
        await cipher?.close();
      }
      for (const file of manifest.databases) {
        const path = file.path.slice('store/'.length);
        await Deno.mkdir(dirname(join(target.store, path)), {
          recursive: true,
          mode: 0o700,
        });
        await Deno.rename(join(unpack, file.path), join(target.store, path));
      }
      for (const path of new Set(manifest.media.map((file) => file.path))) {
        await copyPrivate(
          join(unpack, path),
          join(target.media, basename(path)),
        );
      }
      const deployment = join(target.store, 'deployment');
      await Deno.rename(join(unpack, 'deployment'), deployment);
      await removeOwned(unpack);
      const portable = await restoreDeployment(
        manifest,
        deployment,
        storeRoot,
        mediaRoot,
        settings,
      );
      const files = manifest.databases.map((file) => ({
        kind: file.kind,
        id: file.id,
        path: file.path.slice('store/'.length),
      }));
      const report = await withCandidateStore(
        settings.config.store,
        target.store,
        files,
        { room: roomSchema, tenant: tenantSchema, server: serverSchema },
        async (candidate) => {
          for (const file of candidate.files) {
            if (
              file.schemaVersion !==
                manifest.databases.find((archived) =>
                  archived.path === 'store/' + file.path
                )!.schemaVersion
            ) {
              throw new Error(
                'restore database schema does not match manifest',
              );
            }
          }
          const audit = await auditSnapshot(
            settings.config.store,
            target.store,
            files,
            manifest.serverName,
            target.store,
          );
          if (
            JSON.stringify(audit.tenants) !== JSON.stringify(manifest.tenants)
          ) throw new Error('restore signing identity does not match manifest');
          const expectedMedia = new Set(
            manifest.media.map((m) => JSON.stringify([m.tenant, m.id, m.path])),
          );
          if (
            audit.media.length !== expectedMedia.size ||
            audit.media.some((m) =>
              !expectedMedia.has(JSON.stringify([m.tenant, m.id, m.path])) ||
              manifest.payloads.find((p) => p.path === m.path)?.size !== m.size
            )
          ) throw new Error('restore uploaded media inventory mismatch');
          const sanitation = [];
          for (
            const file of candidate.files.filter((f) => f.kind === 'tenants')
          ) {
            sanitation.push({
              tenant: file.id,
              ...await candidate.tx(
                file,
                async (conn) => ({
                  ...await sanitizeRestoredTenant(conn),
                  deviceStreams: await rebaseRestoredDeviceStreams(conn),
                }),
              ),
            });
          }
          const server = candidate.files.find((f) => f.kind === 'server')!;
          const recovery = await candidate.tx(
            server,
            async (conn) => ({
              state: await beginRecovery(conn),
              remoteDeviceCaches: await invalidateRestoredDeviceCaches(conn),
            }),
          );
          const verified = await auditSnapshot(
            settings.config.store,
            target.store,
            files,
            manifest.serverName,
            target.store,
          );
          const now = Date.now();
          const report: RestoreReport = {
            format: 1,
            id: recovery.state.reportId,
            epoch: recovery.state.epoch,
            backupId: manifest.backupId,
            cut: {
              started: manifest.cut.startedAt,
              completed: manifest.cut.endedAt,
            },
            restoredAt: new Date(now).toISOString(),
            audits: {
              databases: verified.databases,
              historicalUnheldReceipts: verified.historicalUnheldReceipts,
            },
            migrations: candidate.files.map((f) => ({
              kind: f.kind,
              id: f.id,
              from: f.schemaVersion,
              to: f.migratedTo,
            })),
            sanitation: {
              tenants: sanitation,
              remoteDeviceCaches: recovery.remoteDeviceCaches,
            },
            pendingWork: await inventoryRestoredWork(candidate, now),
            warnings: restoreWarnings(portable.externalSecrets),
          };
          await writeRestoreReport(candidate, target.store, report);
          return report;
        },
      );
      // Candidate connections and native handles have drained before the first
      // root rename. The storage owner holds target ownership through both roots.
      const replaced = await target.promote();
      return {
        path: storeRoot,
        media: mediaRoot,
        configPath: portable.path,
        reportPath: join(storeRoot, 'restore-reports', report.id + '.json'),
        report,
        replaced,
      };
    },
  );
}
