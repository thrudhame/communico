import type { CapturedQuery } from '#engine/store/inspect.ts';
import { inventoryRows } from '#engine/backup/checks.ts';

export async function restoredRoomWork(db: CapturedQuery, position: number) {
  const deliveries = await inventoryRows(
    db,
    'changes',
    "pos,event,json_extract(data,'$.destinations') AS destinations",
    "pos>? AND kind='delivery'",
    [position],
  );
  const [{ count, head }] = await db.query(
    'SELECT COUNT(*) AS count,COALESCE(MAX(pos),0) AS head FROM changes WHERE pos>?',
    [position],
  );
  const [completion] = await db.query(
    'SELECT generation,legacy_through,completed_through FROM completion_state',
  );
  const receipts = await inventoryRows(
    db,
    'completion_receipts',
    'event,through,basis',
  );
  return {
    position,
    head: Number(head),
    unprojectedChanges: Number(count),
    deliveries,
    completion: {
      generation: String(completion.generation),
      legacyThrough: Number(completion.legacy_through),
      completedThrough: Number(completion.completed_through),
      receipts,
      publishedThrough: position,
      callbackPending: Number(completion.completed_through) < position,
    },
  };
}
