import type { App } from '#engine/app.ts';
import { createBackup } from '#engine/backup/bundle.ts';
import { AdminError, type Operation, text } from '#root/api/admin/protocol.ts';

export function backupOperations(app: App): Record<string, Operation> {
  return {
    '/v1/backup': async (body) => {
      const destination = text(body, 'destination');
      if (destination.length === 0 || destination.includes('\0')) {
        throw new AdminError(
          'BAD_REQUEST',
          'destination must be a nonempty path',
        );
      }
      const result = await createBackup(app.store, destination);
      return {
        path: result.path,
        backupId: result.manifest.backupId,
        pauseMs: result.manifest.cut.pauseMs,
        encryption: result.manifest.encryption,
      };
    },
  };
}
