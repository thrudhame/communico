// Listing retention is not count retention. A pruned read entry can later become
// unread after relation reconciliation; its immutable notification fact survives.
import { config } from '#engine/config.ts';
import type { Conn, Database } from '#engine/store/db.ts';

export function notificationHistoryCutoff(now: number): number {
  return now - config().push.readretentiondays * 86400000;
}

export async function syncNotificationHistory(
  tx: Conn,
  seq: number,
  now: number,
): Promise<void> {
  const cutoff = notificationHistoryCutoff(now);
  await tx.execute('DELETE FROM notification_history WHERE seq=?', [seq]);
  await tx.execute(
    `INSERT INTO notification_history(seq,user,room,highlight,read_ms)
    SELECT seq,user,room,highlight,read_ms FROM notifications WHERE seq=? AND withdrawn=0 AND (read_ms IS NULL OR read_ms>?)`,
    [seq, cutoff],
  );
}

export async function pruneNotificationHistory(
  tx: Conn,
  now: number,
): Promise<void> {
  const cutoff = notificationHistoryCutoff(now);
  await tx.execute(
    'DELETE FROM notification_history WHERE read_ms<=?',
    [cutoff],
  );
}

/** The app owns the timer and drains in-flight maintenance before storage closes.
 * Receipts remove zero-day entries in their own transaction, not on this timer. */
export async function startNotificationHistory(
  server: Database,
): Promise<() => Promise<void>> {
  await server.tx((tx) => pruneNotificationHistory(tx, Date.now()));
  let pending: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (pending !== null) return;
    pending = server.tx((tx) => pruneNotificationHistory(tx, Date.now()))
      .catch((error) => console.error('push history maintenance:', error))
      .finally(() => {
        pending = null;
      });
  }, 60000);
  return async () => {
    clearInterval(timer);
    await pending;
  };
}
