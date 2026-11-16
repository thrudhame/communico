import type { CapturedQuery } from '#engine/store/inspect.ts';
import { inventoryRows } from '#engine/backup/checks.ts';
import {
  tenantProjectionSources,
  tenantSource,
} from '#engine/store/projection-sources.ts';

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
    const suffix of Object.keys(
      tenantProjectionSources,
    ) as (keyof typeof tenantProjectionSources)[]
  ) {
    const table = tenantProjectionSources[suffix];
    const source = tenantSource(suffix, tenant);
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
