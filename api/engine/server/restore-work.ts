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
  const egress = await inventoryRows(
    db,
    'facade_egress',
    'destination,txn_id,body,mode,pairing,(result_json IS NOT NULL) AS completed',
  );
  for (const row of egress) {
    row.sha256 = createHash('sha256').update(String(row.body)).digest('hex');
    row.bytes = new TextEncoder().encode(String(row.body)).length;
    delete row.body;
  }
  const prejoin = await inventoryRows(
    db,
    'prejoin_jobs',
    'job_id,room_id,user_id,event_id,action,status,revision,expires_ms',
    "status IN ('rejecting','failed-retract','attempting','failed-attempt')",
  );
  const joins = await inventoryRows(
    db,
    'federation_join_attempts',
    'room_id,user_id,event_id,destination,added_ms,(leave_json IS NOT NULL) AS prepared',
  );
  const invites = await inventoryRows(
    db,
    'federation_invite_attempts',
    'room_id,sender,target,event_id,destination,status,added_ms,(response_json IS NOT NULL) AS prepared',
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
    upgrades: await inventoryRows(
      db,
      'room_upgrades',
      'old_room_id,user_id,replacement_room,phase',
      'phase<4',
    ),
    federation: { pdus, edus, frozen, prejoin, joins, invites },
    push: { deliveries, badges },
    // Both terminal evidence and unfinished work are needed to reconcile a
    // surviving node. Never treat a report row as permission to advance a cut.
    facade: {
      identity: await inventoryRows(
        db,
        'runtime_identity',
        'role,server_name,node_id,initialized',
      ),
      pairings: await inventoryRows(
        db,
        'facade_pairings',
        'id,side,node,state,revision,retired_ms',
      ),
      controls: await inventoryRows(
        db,
        'facade_owner_controls',
        'pairing,revision,body_hash',
      ),
      activation: await inventoryRows(
        db,
        'facade_owner_activation',
        'pairing,revision,body_hash',
      ),
      streams: await inventoryRows(
        db,
        'facade_streams',
        'peer,direction,source,incarnation,stream,received,received_hash,applied,applied_hash',
      ),
      acknowledgements: await inventoryRows(
        db,
        'facade_export_acks',
        'peer,source,incarnation,stream,received,received_hash,applied,applied_hash',
      ),
      records: await inventoryRows(
        db,
        'facade_records',
        'peer,direction,source,incarnation,stream,sequence,operation_id,hash,bytes,(result_json IS NOT NULL) AS completed',
      ),
      exports: await inventoryRows(
        db,
        'facade_exports',
        'peer,incarnation,scope,source_cut',
      ),
      scopes: await inventoryRows(
        db,
        'facade_scopes',
        'incarnation,scope,source_cut,ready,pending_hash',
      ),
      ingress: await inventoryRows(
        db,
        'facade_ingress',
        'origin,txn_id,input_hash,bytes,pairing,revision,source,incarnation,record_sequence,record_hash,ingress_phase,(response_json IS NOT NULL) AS completed',
      ),
      children: await inventoryRows(
        db,
        'facade_ingress_children',
        'origin,txn_id,kind,child_key',
      ),
      collisions: await inventoryRows(
        db,
        'facade_ingress_collisions',
        'origin,txn_id,input_hash',
      ),
      eduPolicies: await inventoryRows(
        db,
        'facade_ingress_edu_policy',
        'origin,message_id,payload_hash,phase',
      ),
      egress,
      routes: await inventoryRows(
        db,
        'facade_egress_routes',
        'destination,peer,pairing',
      ),
      membership: await inventoryRows(
        db,
        'membership_operations',
        'operation,room_id,input_hash',
      ),
      operations: await inventoryRows(
        db,
        'domain_operations',
        'operation_id,source,incarnation,stream,sequence,semantic_key,kind,payload_hash,applied',
      ),
      frontiers: await inventoryRows(
        db,
        'domain_frontiers',
        'semantic_key,operation_id',
      ),
      conflicts: await inventoryRows(
        db,
        'domain_conflicts',
        'semantic_key,operation_id',
      ),
    },
  };
}
