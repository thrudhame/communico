// Restore-era delivery identity and its durable operator-report release marker.
import type { Conn, Database } from '#engine/store/db.ts';

export const RECOVERY_SQL =
  `CREATE TABLE restore_state(id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),epoch TEXT NOT NULL,report_id TEXT NOT NULL,report_sha256 TEXT);`;

export type RecoveryState = {
  epoch: string;
  reportId: string;
  reportSha256: string | null;
};

export async function recoveryState(
  db: Pick<Database, 'query'>,
): Promise<RecoveryState | null> {
  const rows = await db.query(
    'SELECT epoch,report_id,report_sha256 FROM restore_state WHERE id=1',
  );
  if (!rows.length) return null;
  const row = rows[0];
  if (
    typeof row.epoch !== 'string' || !/^[0-9a-f]{32}$/.test(row.epoch) ||
    typeof row.report_id !== 'string' ||
    !/^[0-9a-f]{32}$/.test(row.report_id) ||
    (row.report_sha256 !== null &&
      (typeof row.report_sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(row.report_sha256)))
  ) {
    throw new Error('invalid restore recovery marker');
  }
  return {
    epoch: row.epoch,
    reportId: row.report_id,
    reportSha256: row.report_sha256 as string | null,
  };
}

export async function beginRecovery(conn: Conn): Promise<RecoveryState> {
  const state = {
    epoch: crypto.randomUUID().replaceAll('-', ''),
    reportId: crypto.randomUUID().replaceAll('-', ''),
    reportSha256: null,
  };
  await conn.execute(
    'INSERT INTO restore_state VALUES(1,?,?,NULL) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,report_id=excluded.report_id,report_sha256=NULL',
    [state.epoch, state.reportId],
  );
  return state;
}

export async function completeRecovery(
  conn: Conn,
  state: RecoveryState,
  sha256: string,
): Promise<void> {
  const current = await recoveryState(conn);
  if (
    !current || current.epoch !== state.epoch ||
    current.reportId !== state.reportId || current.reportSha256 !== null ||
    !/^[0-9a-f]{64}$/.test(sha256)
  ) {
    throw new Error('restore report marker changed or is already complete');
  }
  await conn.execute('UPDATE restore_state SET report_sha256=? WHERE id=1', [
    sha256,
  ]);
}
