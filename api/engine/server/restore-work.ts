import { createHash } from 'node:crypto';
import type { CapturedQuery } from '#engine/store/inspect.ts';
import { inventoryRows } from '#engine/backup/checks.ts';

/** Inspect delivery truth, never sender APIs: no network/ack/prune side effects. */
export async function restoredServerWork(db: CapturedQuery) {
  const pdus = await inventoryRows(
    db,
    'outbox',
    'room,pos,destination,event,state,attempts,next_attempt_ms,added_ms',
    "state!='sent'",
  );
  const edus = await inventoryRows(
    db,
    'edu_outbox',
    'source,destination,edu_type,state,enqueue_pos',
  );
  const frozen = await inventoryRows(
    db,
    'federation_batches',
    'destination,txn_id,body,pdu_rows,edu_sources',
  );
  for (const row of frozen) {
    row.sha256 = createHash('sha256').update(String(row.body)).digest('hex');
    row.bytes = new TextEncoder().encode(String(row.body)).length;
    delete row.body;
  }
  const prejoin = await inventoryRows(
    db,
    'prejoin_memberships',
    'room_id,user_id,event_id,origin,kind,status,revision,expires_ms',
    "status IN ('rejecting','failed-retract','attempting','failed-attempt')",
  );
  const joins = await inventoryRows(
    db,
    'federation_join_attempts',
    'room_id,user_id,event_id,destination,added_ms,(leave_json IS NOT NULL) AS prepared',
  );
  const deliveries = await inventoryRows(
    db,
    'push_delivery',
    'incarnation,notification_seq,user,room,event,created_ms,state,attempts,next_ms',
    "state='pending'",
  );
  const badges = await inventoryRows(
    db,
    'push_badges',
    'incarnation,user,revision,sent_revision,expired_revision,attempts,next_ms,created_ms',
    'revision>MAX(sent_revision,expired_revision)',
  );
  return {
    federation: { pdus, edus, frozen, prejoin, joins },
    push: { deliveries, badges },
  };
}
