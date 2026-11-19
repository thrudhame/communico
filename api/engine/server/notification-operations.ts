// Saved evaluations are immutable source facts, not a register winner. The
// existing account stream retains every context; each notification owner chooses
// its native context first and home's context for an imported-only fallback.
import type { Conn } from '#engine/store/db.ts';
import type { PublicationDecision } from './push-project.ts';
import {
  importRegisterOperation,
  readRegister,
  registerJson,
  type RegisterOperation,
  registerOperations,
  writeRegister,
} from '#engine/facade/registers.ts';
import {
  type DomainHistoryProof,
  requireDomainSources,
} from '#engine/facade/domain-control.ts';
import { PUSH_KINDS } from '#engine/push/defaults.ts';

export type SavedNotification = {
  tenant: string;
  user: string;
  room: string;
  event: string;
  source: 'room' | 'invite';
  ruleRevision: number;
  ignoreRevision: number;
  ruleId: string | null;
  ruleKind: string | null;
  notify: boolean;
  actions: unknown[];
  highlight: boolean;
  createdMs: number;
};

function key(value: Pick<SavedNotification, 'user' | 'room' | 'event'>) {
  return JSON.stringify([
    'notification',
    value.user.slice(1, value.user.indexOf(':')),
    value.room,
    value.event,
  ]);
}

export async function notificationAuthority(conn: Pick<Conn, 'query'>) {
  const [row] = await conn.query(
    'SELECT c.signed_json,p.node FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision CROSS JOIN publication_domain p WHERE p.singleton=1',
  );
  if (!row) return null;
  const body = JSON.parse(String(row.signed_json)).body;
  const nodes = body.nodes as { node: string; incarnation: string }[];
  const own = nodes.find((node) => node.node === row.node);
  if (!own) throw new Error('notification source unavailable');
  return {
    server: String(body.server),
    source: own.node,
    incarnation: own.incarnation,
    nodes,
  };
}

export function savedNotification(
  operation: RegisterOperation,
): SavedNotification {
  const value = JSON.parse(operation.payload) as SavedNotification;
  const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  if (
    !value || typeof value.tenant !== 'string' ||
    typeof value.user !== 'string' || !/^@[^:]+:.+$/.test(value.user) ||
    value.user.slice(value.user.indexOf(':') + 1) !== value.tenant ||
    typeof value.room !== 'string' || !/^!\S+:\S+$/.test(value.room) ||
    typeof value.event !== 'string' || !/^\$\S+$/.test(value.event) ||
    !['room', 'invite'].includes(value.source) ||
    !integer(value.ruleRevision) || !integer(value.ignoreRevision) ||
    !integer(value.createdMs) || typeof value.notify !== 'boolean' ||
    typeof value.highlight !== 'boolean' || !Array.isArray(value.actions) ||
    !(value.ruleId === null || typeof value.ruleId === 'string') ||
    !(value.ruleKind === null ||
      PUSH_KINDS.includes(value.ruleKind as typeof PUSH_KINDS[number])) ||
    operation.kind !== 'notification' || operation.semanticKey !== key(value) ||
    registerJson(operation.payload) !== registerJson(JSON.stringify({
        tenant: value.tenant,
        user: value.user,
        room: value.room,
        event: value.event,
        source: value.source,
        ruleRevision: value.ruleRevision,
        ignoreRevision: value.ignoreRevision,
        ruleId: value.ruleId,
        ruleKind: value.ruleKind,
        notify: value.notify,
        actions: value.actions,
        highlight: value.highlight,
        createdMs: value.createdMs,
      }))
  ) throw new Error('invalid saved notification');
  return value;
}

export async function notificationOperations(conn: Conn, user: string) {
  const keys = await conn.query(
    "SELECT DISTINCT semantic_key FROM domain_operations WHERE kind='notification' AND json_extract(payload_json,'$.user')=? ORDER BY semantic_key",
    [user],
  );
  const out: RegisterOperation[] = [];
  for (const row of keys) {
    out.push(...await registerOperations(conn, String(row.semantic_key)));
  }
  return out;
}

/** Caller owns the same server transaction as the public evaluation. No source
 * fact is rewritten when rules change or a publication is retried. */
export async function recordNotificationOperation(
  conn: Conn,
  room: string,
  event: string,
  source: 'room' | 'invite',
  input: PublicationDecision,
  now: number,
) {
  const authority = await notificationAuthority(conn);
  if (!authority || authority.server !== input.tenant) return null;
  const semanticKey = key({ user: input.user, room, event });
  const prior = (await registerOperations(conn, semanticKey)).find((op) =>
    op.source === authority.source && op.incarnation === authority.incarnation
  );
  if (prior) return { operation: prior, created: false };
  const decision = input.decision;
  const value: SavedNotification = {
    tenant: input.tenant,
    user: input.user,
    room,
    event,
    source,
    ruleRevision: input.ruleRevision,
    ignoreRevision: input.ignoreRevision,
    ruleId: decision?.ruleId ?? null,
    ruleKind: decision?.kind ?? null,
    notify: decision?.notify ?? false,
    actions: decision?.actions ?? [],
    highlight: decision?.highlight ?? false,
    createdMs: now,
  };
  const result = await writeRegister(
    conn,
    authority,
    semanticKey,
    'notification',
    JSON.stringify(value),
  );
  return { operation: result.operation, created: true };
}

export async function acceptNotificationOperation(
  conn: Conn,
  operation: RegisterOperation,
  history?: DomainHistoryProof,
) {
  const value = savedNotification(operation);
  const authority = await notificationAuthority(conn);
  if (!authority || value.tenant !== authority.server) {
    throw new Error('notification source unavailable');
  }
  await requireDomainSources(
    conn,
    operation,
    authority.nodes.map((node) => ({
      source: node.node,
      incarnation: node.incarnation,
    })),
    value.user.slice(1, value.user.indexOf(':')),
    history,
  );
  // One native saved evaluation per source incarnation and event/account.
  // A register successor is not permission to revise a historical evaluation.
  const prior = (await registerOperations(conn, operation.semanticKey)).find((
    op,
  ) =>
    op.source === operation.source && op.incarnation === operation.incarnation
  );
  if (
    prior &&
    registerJson(JSON.stringify(prior)) !==
      registerJson(JSON.stringify(operation))
  ) {
    throw new Error('saved notification changed');
  }
  await importRegisterOperation(conn, operation);
  return value;
}

/** Capture only held native rows. Imported projections always carry their
 * original operation pointer, so an export never relabels replica evaluations.
 * Legacy suppressions did not retain actions/time: empty/zero records that
 * absence, not a reevaluation under today's rules. */
export async function captureNotificationOperations(conn: Conn, user: string) {
  const authority = await notificationAuthority(conn);
  if (!authority || user.slice(user.indexOf(':') + 1) !== authority.server) {
    throw new Error('notification source unavailable');
  }
  const rows = await conn.query(
    'SELECT e.*,n.actions,n.highlight,n.created_ms FROM push_evaluations e LEFT JOIN notifications n ON n.tenant=e.tenant AND n.user=e.user AND n.event=e.event WHERE e.user=? AND e.operation_id IS NULL',
    [user],
  );
  for (const row of rows) {
    const recorded = await recordNotificationOperation(
      conn,
      String(row.room),
      String(row.event),
      row.source === 'invite' ? 'invite' : 'room',
      {
        tenant: String(row.tenant),
        user,
        ruleRevision: Number(row.rule_revision),
        ignoreRevision: Number(row.ignore_revision),
        decision: row.rule_id === null ? null : {
          ruleId: String(row.rule_id),
          kind: row.rule_kind as typeof PUSH_KINDS[number],
          notify: row.actions !== null,
          actions: row.actions === null ? [] : JSON.parse(String(row.actions)),
          highlight: Number(row.highlight ?? 0) !== 0,
          tweaks: {},
        },
      },
      Number(row.created_ms ?? 0),
    );
    await conn.execute(
      'UPDATE push_evaluations SET operation_id=? WHERE tenant=? AND user=? AND event=?',
      [
        recorded!.operation.operationId,
        String(row.tenant),
        user,
        String(row.event),
      ],
    );
  }
  return await notificationOperations(conn, user);
}

export async function selectedNotificationOperation(
  conn: Conn,
  semanticKey: string,
) {
  const authority = await notificationAuthority(conn);
  if (!authority) return null;
  const view = await readRegister(conn, semanticKey);
  const pending = new Set(view.pending.map((op) => op.operationId));
  const retired = new Set((await conn.query(
    "SELECT operation_id FROM domain_operations WHERE kind='notification' AND semantic_key=? AND applied=-1",
    [semanticKey],
  )).map((row) => String(row.operation_id)));
  const ready = (await registerOperations(conn, semanticKey)).filter((op) =>
    !pending.has(op.operationId) && !retired.has(op.operationId)
  );
  const [native] = await conn.query(
    'SELECT e.operation_id FROM push_evaluations e JOIN domain_operations o ON o.operation_id=e.operation_id WHERE o.semantic_key=? AND e.native=1',
    [semanticKey],
  );
  return ready.find((op) => op.operationId === native?.operation_id) ??
    ready.filter((op) => op.source === 'home').at(-1) ?? ready.at(-1) ?? null;
}
