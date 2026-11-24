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
  const completionReceipts = await inventoryRows(
    db,
    'transaction_completions',
    'localpart,device_id,generation,endpoint,txn_id,room_id,room_generation,event_id,through,retired',
  );
  const pendingCompletions = await inventoryRows(
    db,
    'client_completion_cuts',
    'localpart,device_id,generation,room_id,room_generation,through,revision',
  );
  return {
    delayed,
    toDevice,
    submissions,
    unprojected,
    completionReceipts,
    pendingCompletions,
    // Original owner histories, target/consumption tombstones and per-record
    // receipts survive independently of mutable projections. Omit all payloads
    // and bearer/credential material, including the dispatch and ACK secrets.
    facade: {
      authority: await inventoryRows(
        db,
        'tenant_authority',
        'node,incarnation,home_incarnation,edge_node,edge_incarnation',
      ),
      facts: await inventoryRows(
        db,
        'authority_facts',
        'id,node,incarnation,seq,localpart,kind',
      ),
      devices: await inventoryRows(
        db,
        'authority_devices',
        'localpart,device_id,incarnation,generation',
      ),
      authSources: await inventoryRows(
        db,
        'account_auth_sources',
        'localpart,revision,captured_ms',
      ),
      authSnapshots: await inventoryRows(
        db,
        'account_auth_snapshots',
        'localpart,pairing,grant_revision,owner_revision,source_cut,revision,captured_ms,checked_ms,credentials',
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
      deviceOperations: await inventoryRows(
        db,
        'device_operations',
        'operation_id,source,incarnation,sequence,localpart,device_id,device_incarnation,payload_hash',
      ),
      signingOperations: await inventoryRows(
        db,
        'signing_operations',
        'operation_id,source,incarnation,sequence,localpart',
      ),
      signatureOperations: await inventoryRows(
        db,
        'signature_operations',
        'operation_id,source,incarnation,sequence,localpart,target_user,target_key',
      ),
      consumptions: await inventoryRows(
        db,
        'key_consumptions',
        'localpart,device_id,generation,algorithm,key_id',
      ),
      admissions: await inventoryRows(
        db,
        'to_device_admissions',
        'kind,origin,message_id,payload_hash,policy',
      ),
      toDeviceOperations: await inventoryRows(
        db,
        'to_device_operations',
        'operation_id,source,incarnation,sequence,localpart,kind,payload_hash',
      ),
      routes: await inventoryRows(
        db,
        'to_device_routes',
        'route_id,localpart,expanded',
      ),
      targets: await inventoryRows(
        db,
        'to_device_targets',
        'target_id,route_id,localpart,device_id,device_incarnation,generation,state',
      ),
      inbox: await inventoryRows(
        db,
        'to_device_inbox',
        'localpart,device_id,generation,msg_pos,source_id',
      ),
      acknowledgements: await inventoryRows(
        db,
        'device_ack',
        'localpart,device_id,generation,msg_pos',
      ),
      applications: await inventoryRows(
        db,
        'facade_link_applications',
        'peer,source,incarnation,stream,sequence,hash,projection_revision',
      ),
      profileFanout: await inventoryRows(
        db,
        'profile_fanout_rooms',
        'localpart,revision,room_id,event_id,completed,accepted',
      ),
    },
  };
}
