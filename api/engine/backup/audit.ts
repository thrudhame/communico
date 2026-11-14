// Compose domain audits over private store-owned inspection copies. Neither
// archived files nor a live app are opened, rolled forward or served here.
import { inspectSnapshot } from '#engine/store/inspect.ts';
import type { SnapshotFile, StoreConfig } from '#engine/store/index.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { auditRoom } from '#engine/room/backup-audit.ts';
import { auditTenant } from '#engine/tenant/backup-audit.ts';
import { auditServer } from '#engine/server/backup-audit.ts';
import { auditFailure } from './checks.ts';
import type { Manifest } from './manifest.ts';

export async function auditSnapshot(
  config: Pick<StoreConfig, 'library' | 'checkpointlogbytes'>,
  root: string,
  files: readonly SnapshotFile[],
  serverName: string,
  workspace: string,
) {
  return await inspectSnapshot(config, root, files, workspace, {
    room: roomSchema,
    tenant: tenantSchema,
    server: serverSchema,
  }, async (snapshot) => {
    const databases: Manifest['databases'] = [];
    const tenants: Manifest['tenants'] = [];
    const media: { tenant: string; id: string; path: string; size: number }[] =
      [];
    for (const file of snapshot.files) {
      if (file.kind === 'server') continue;
      let heads: Record<string, number>;
      if (file.kind === 'rooms') {
        heads = await snapshot.read(file, (db) => auditRoom(db, file.id!));
      } else {
        const result = await snapshot.read(
          file,
          (db) => auditTenant(db, file.id!),
        );
        tenants.push(result.identity);
        media.push(...result.media);
        heads = result.heads;
      }
      databases.push({ ...file, path: 'store/' + file.path, heads });
    }
    if (!tenants.some((t) => t.id === serverName)) {
      auditFailure('configured server identity missing');
    }
    const server = snapshot.files.find((f) => f.kind === 'server')!;
    const result = await auditServer(snapshot, server, databases);
    databases.unshift({
      ...server,
      path: 'store/' + server.path,
      heads: result.heads,
    });
    return {
      databases,
      tenants,
      media,
      historicalUnheldReceipts: result.historicalUnheldReceipts,
    };
  });
}
