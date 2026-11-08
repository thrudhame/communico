import { theApp } from '#engine/app.ts';
import { localpartOf } from '#engine/ids.ts';
import type { Action } from '#engine/tenant/key-backup.ts';

export function backupVersion(
  user: string,
  action: Action,
  version?: string,
  body?: unknown,
) {
  return theApp().tenant.tx((tx) =>
    tx.keyBackup.version(localpartOf(user), action, version, body)
  );
}
export function backupKeys(
  user: string,
  action: Action,
  version: string | null,
  room?: string,
  session?: string,
  body?: unknown,
) {
  return theApp().tenant.tx((tx) =>
    tx.keyBackup.keys(localpartOf(user), action, version, room, session, body)
  );
}
