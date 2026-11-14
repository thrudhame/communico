import type { CapturedStore } from '#engine/store/inspect.ts';
import { restoredServerWork } from '#engine/server/restore-work.ts';
import { restoredTenantWork } from '#engine/tenant/restore-work.ts';
import { restoredRoomWork } from '#engine/room/restore-work.ts';

export async function inventoryRestoredWork(
  snapshot: CapturedStore,
  now: number,
) {
  const server = snapshot.files.find((file) => file.kind === 'server')!;
  const marks = new Map(
    (await snapshot.read(
      server,
      (db) => db.query('SELECT source,position FROM watermarks'),
    )).map((
      row,
    ) => [String(row.source), Number(row.position)]),
  );
  const work = await snapshot.read(server, restoredServerWork);
  const tenants = [], rooms = [];
  for (const file of snapshot.files) {
    if (file.kind === 'tenants') {
      tenants.push({
        id: file.id!,
        ...await snapshot.read(
          file,
          (db) => restoredTenantWork(db, now, marks, file.id!),
        ),
      });
    }
    if (file.kind === 'rooms') {
      rooms.push({
        id: file.id!,
        ...await snapshot.read(
          file,
          (db) => restoredRoomWork(db, marks.get('room:' + file.id) ?? 0),
        ),
      });
    }
  }
  return { ...work, tenants, rooms };
}

export function restoreWarnings(externalSecrets: readonly string[]): string[] {
  return [
    'The report records the backup cut and restore time. Changes after that cut are absent; the cut-to-restore interval is the recovery-point loss window.',
    'Lost post-cut cancellations, completions and peer acknowledgments cannot be reconstructed. Restored delayed commands, federation work and push work resume with their ordinary delivery semantics after this report is durable; overdue work can execute immediately and already observed effects can repeat.',
    'Restored password hashes, access/refresh credentials and security decisions reflect the cut. Post-cut password changes, logout, revocation, device deletion and membership/account-data changes can be lost; old credentials can become valid again.',
    'All restored one-time keys and fallback pools are purged. Public device/cross-signing keys, signatures, signing identity and encrypted Megolm backups are retained; clients must retain their private crypto stores and refill keys. Lost post-cut private keys or encrypted sessions cannot be recovered from this server archive.',
    'Sync epochs, sliding-position resets and peer full-resnapshot requests recover delivery boundaries, not missing post-cut history or every newer client cache entry. Frozen federation transaction bytes and source identities are retained, never regenerated.',
    'Clients can retain rooms created after the cut and account-data types first written after the cut: the archive cannot name these objects to remove them from newer caches. Before optional signout, clients must securely preserve their private crypto stores and recovery secrets; the server cannot export those stores. The operator can then use existing device/token revocation to sign users out so clients drop these caches on next login; this is never automatic.',
    'The restore report and archive contain sensitive account and deployment metadata. Keep them private; protect the signing private keys and password hashes. Remote/generated media caches and runtime files are excluded.',
    ...(externalSecrets.length
      ? [
        'Environment-sourced deployment secrets must be supplied separately: ' +
        externalSecrets.join(', ') + '.',
      ]
      : []),
  ];
}
