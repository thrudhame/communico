// Explicit durable-table inventory, independent of CREATE TABLE statements.
// Adding a schema table requires choosing its backup disposition here; the
// fast fresh/migrated-schema test and captured-file audit both enforce it.
// Every registered table is retained in the atomic database cut. Domain audits
// below additionally check source references, allocators and identity. Restore
// sanitation remains owned by backup/sanitize.ts, never this inventory.
import type { CapturedQuery } from '#engine/store/inspect.ts';
import { auditFailure } from './checks.ts';

// The pinned native engine creates its own durable MVCC metadata table.
const shared = ['id', 'meta', '__turso_internal_mvcc_meta'];
const causal = [
  'facade_owner_controls',
  'facade_owner_activation',
  'domain_operations',
  'domain_frontiers',
  'domain_conflicts',
];

export const tableContracts = {
  rooms: {
    // Immutable room truth and its local reference indexes: auditRoom.
    truth: [
      'events',
      'event_signatures',
      'event_status',
      'event_topology',
      'prev_edges',
      'auth_edges',
      'state_groups',
      'state_entries',
      'event_state',
      'segments',
      'positions',
      'extremities',
      'changes',
      'publications',
      'publication_keys',
    ],
    // Accepted recovery obligations and immutable saved remote results.
    retained: [
      'waits',
      'remote_batches',
      'membership_receipts',
      'local_join_observations',
      'membership_receipt_wires',
    ],
    // Room identity/exact acceptance cuts: auditRoom; completed progress is also
    // checked against server publication by auditServer.
    completion: ['completion_state', 'completion_receipts'],
  },
  tenants: {
    // Identity/signing and stream ceilings: auditTenant.
    identity: [
      'tenant',
      'counters',
      'account_changes',
      'e2ee_changes',
      'pusher_changes',
      'account_data',
      'push_rules',
      'push_rules_stream',
      'devices',
      'cross_signing_keys',
      'key_pool_updates',
      'to_device_inbox',
    ],
    // Room references and reliable outbox handoff: auditServer.
    sources: ['transactions', 'to_device_intents'],
    // Client-owned exact completion targets and causal cuts: auditTenant checks
    // client identity/revisions; auditServer checks their captured room truth.
    completion: ['transaction_completions', 'client_completion_cuts'],
    // Complete opaque owner state, not reconstructible from room/server rows.
    retained: [
      'users',
      'credentials',
      'access_tokens',
      'refresh_tokens',
      'uia_sessions',
      'device_keys',
      'user_device_stream',
      'to_device_transactions',
      'device_ack',
      'inbound_to_device',
      'key_signatures',
      'backup_versions',
      'backup_sessions',
      'backup_rooms',
      'pushers',
      'media',
      'filters',
      'openid_tokens',
      'profile_fields',
      'erased_users',
      'delayed_events',
      'delayed_event_receipts',
      'public_user_replicas',
      'deactivation_work',
      'account_auth_sources',
      'account_auth_snapshots',
      'account_auth_publications',
      'tenant_authority',
      'authority_facts',
      'authority_devices',
      'session_authority',
      // Device owners retain immutable semantic history, consumption fences and
      // exact link receipts. No replay or restore may create claim authority.
      'key_consumptions',
      'device_operations',
      'signing_operations',
      'signature_operations',
      // Includes nullable per-receipt projection_revision, semantic result and
      // publication hints. counters also retains the legacy projection cut.
      'facade_link_applications',
      'key_bootstrap_publications',
      'device_creation_history',
      'device_stream_publications',
      'device_stream_predecessors',
      'device_stream_frontier',
      'device_stream_baselines',
      'device_stream_checkpoints',
      // Accepted routed sends, frozen incarnations and their ACK/cancellation
      // dispositions remain durable across backup and owner-local recovery.
      'to_device_admissions',
      'to_device_operations',
      'to_device_routes',
      'to_device_targets',
      'profile_fanout',
      'profile_fanout_rooms',
      ...causal,
    ],
    // Preserve the cut, then sanitize through the restore owner before serving.
    restored: [
      'one_time_keys',
      'fallback_keys',
      'sync_deliveries',
      'sliding_sync_connections',
      'sliding_sync_positions',
    ],
    // Supported v3 upgrades retain unattributable receipts read-only.
    historical: ['transactions_v3'],
  },
  server: {
    // Immutable held room evidence: auditServer checks every event/edge and
    // membership meaning. Unknown read targets remain valid pending facts.
    receiptGraph: [
      'receipt_dag_nodes',
      'receipt_dag_edges',
      'receipt_membership_events',
      'notification_graph_reads',
    ],
    // Cross-file references and source cuts: auditServer.
    sources: [
      'watermarks',
      'rooms',
      'event_index',
      'feed',
      'outbox',
      'memberships',
      'redactions',
      'relations',
      'search',
    ],
    // Stream ceilings: auditServer.
    streams: [
      'counters',
      'device_changes',
      'device_notices',
      'notifications',
      'notification_changes',
      'presence',
      'receipts',
      'edu_outbox',
    ],
    // Retain local authoritative facts, frozen obligations and their results;
    // no replica may replace these with another node's allocator positions.
    retained: [
      'aliases',
      'directory',
      'visibility',
      'forgotten',
      'peer_status',
      'federation_txns',
      'federation_peers',
      'federation_blocks',
      'federation_pending',
      'prejoin_memberships',
      'prejoin_jobs',
      'federation_join_attempts',
      'federation_invite_attempts',
      'membership_operations',
      // Original prepared creation identity and request-owned phase/result.
      'room_upgrades',
      'server_keys',
      'server_key_docs',
      'server_key_changes',
      'server_key_decisions',
      'federation_policy',
      'e2ee_rooms',
      'e2ee_room_members',
      'device_tracking',
      'device_subscriptions',
      'device_publications',
      'device_publication_predecessors',
      'device_publication_frontier',
      'device_recovery_requests',
      'public_signing_keys',
      'remote_signing_keys',
      'federation_batches',
      // operation_id binds each public evaluation to its retained notification
      // source context; auditServer checks that durable pointer below.
      'push_evaluations',
      'notification_counts',
      'notification_horizons',
      'notification_receipt_refs',
      'notification_own_events',
      'notification_history',
      // Terminal account lifecycle projection; original source facts survive.
      'notification_retired_users',
      'push_targets',
      'push_rejections',
      'push_delivery',
      'push_badges',
      // Includes reports.report_id: original node identity, not local page IDs.
      // Its immutable submission/resolution facts are retained in causal below.
      'reports',
      'restore_state',
      'facade_node',
      'facade_streams',
      'facade_records',
      'facade_export_acks',
      'facade_control',
      'facade_pairings',
      'runtime_identity',
      'facade_key_roster',
      'facade_exports',
      'facade_scopes',
      'facade_ingress',
      'facade_ingress_children',
      'facade_ingress_collisions',
      'facade_ingress_edu_policy',
      'facade_egress',
      'facade_egress_routes',
      'publication_domain',
      ...causal,
    ],
    // Cache metadata is preserved; existing restore/startup owners invalidate
    // remote keys and reconcile disposable media bytes, not accepted work.
    restored: ['remote_device_users', 'remote_device_keys', 'media_cache'],
  },
} as const;

export async function auditTables(
  db: CapturedQuery,
  kind: keyof typeof tableContracts,
): Promise<void> {
  const names = new Set<string>([
    ...shared,
    ...Object.values(tableContracts[kind]).flat(),
  ]);
  const actual = new Set<string>();
  for (
    const { name } of await db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'",
    )
  ) {
    if (!names.has(String(name))) {
      auditFailure('unregistered durable table: ' + kind + '.' + name);
    }
    actual.add(String(name));
  }
  for (const [disposition, tables] of Object.entries(tableContracts[kind])) {
    if (disposition === 'historical') continue;
    for (const name of tables) {
      if (!actual.has(name)) {
        auditFailure('missing durable table: ' + kind + '.' + name);
      }
    }
  }
}
