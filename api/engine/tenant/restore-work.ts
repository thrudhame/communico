import type { CapturedQuery } from '#engine/store/inspect.ts';
import { inventoryRows } from '#engine/backup/checks.ts';

/** Every retained command, including completed reconciliation work, is visible. */
export async function restoredTenantWork(
  db: CapturedQuery,
  now: number,
  marks: ReadonlyMap<string, number>,
  tenant: string,
) {
  const delayed = await inventoryRows(
    db,
    'delayed_events',
    'id,localpart,room_id,type,state_key,due_ms,phase,event_id,completed,(event_id IS NOT NULL) AS prepared,(completed=0 AND due_ms<=?) AS overdue',
    '1',
    [now],
  );
  const toDevice = await inventoryRows(
    db,
    'to_device_intents',
    'source_id,destination,projected',
  );
  const submissions = await inventoryRows(
    db,
    'transactions',
    'localpart,device_id,generation,endpoint,room_id,txn_id,event_id',
    'completed=0',
  );
  const unprojected = [];
  for (
    const [suffix, table] of [
      ['accounts', 'account_changes'],
      ['e2ee', 'e2ee_changes'],
      ['public-signing', 'e2ee_changes'],
      ['pushers', 'pusher_changes'],
    ]
  ) {
    const source = 'tenant:' + tenant + ':' + suffix;
    const position = marks.get(source) ?? 0;
    const [{ head, count }] = await db.query(
      `SELECT COALESCE(MAX(pos),0) AS head,COUNT(*) AS count FROM ${table} WHERE pos>?`,
      [position],
    );
    if (Number(count)) {
      unprojected.push({
        source,
        position,
        head: Number(head),
        count: Number(count),
      });
    }
  }
  return { delayed, toDevice, submissions, unprojected };
}
