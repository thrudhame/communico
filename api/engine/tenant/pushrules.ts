// api/engine/tenant/pushrules.ts — the push-rules store (plan D9): the
// table behind /pushrules; m.push_rules is SYNTHESISED from it on read,
// never stored as account_data. Priorities are internal ordering only
// (lower = more important, 100-step with midpoint inserts and a re-pack
// when the gap closes). Spec default rules (.m.rule.*) are not seeded —
// the push milestone. The push_rules_stream marker is the stream: EVERY
// mutation stamps it inside the same tenant transaction (so a delete
// that empties the table still moves the token's _a<n>).
import type { Conn } from '#engine/store/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Tenant } from '#engine/tenant/index.ts';

export const PUSH_KINDS = [
  'override',
  'content',
  'room',
  'sender',
  'underride',
] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

// The /pushrules path validation shared by the endpoint files (the
// endpoints tree carries route files only): scope must be `global`
// (pushrules.yaml defines no other), kind one of the five.
export function assertScopeKind(scope: string, kind: string): void {
  if (scope !== 'global') {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'only the global scope is supported',
    );
  }
  if (!(PUSH_KINDS as readonly string[]).includes(kind)) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'unknown rule kind: ' + kind);
  }
}

export type PushRule = {
  rule_id: string;
  actions: unknown[];
  default: boolean;
  enabled: boolean;
  conditions?: unknown[];
  pattern?: string;
};

export type RuleRow = {
  localpart?: string;
  rule_id: string;
  priority: number;
  actions: string;
  conditions: string | null;
  pattern: string | null;
  enabled: boolean;
  is_default: boolean;
};

function ruleRow(row: Record<string, unknown>): RuleRow {
  return {
    rule_id: String(row.rule_id),
    priority: Number(row.priority),
    actions: String(row.actions),
    conditions: row.conditions == null ? null : String(row.conditions),
    pattern: row.pattern == null ? null : String(row.pattern),
    enabled: row.enabled === 1,
    is_default: row.is_default === 1,
  };
}

function rowToRule(row: RuleRow): PushRule {
  const rule: PushRule = {
    rule_id: row.rule_id,
    actions: JSON.parse(row.actions) as unknown[],
    default: row.is_default,
    enabled: row.enabled,
  };
  if (row.conditions !== null) {
    rule.conditions = JSON.parse(row.conditions) as unknown[];
  }
  if (row.pattern !== null) rule.pattern = row.pattern;
  return rule;
}

const RULE_COLUMNS =
  'rule_id, priority, actions, conditions, pattern, enabled, is_default';

// --- conn-level rows (bound on TenantTx) -----------------------------------

export async function kindRows(
  conn: Conn,
  localpart: string,
  kind: string,
): Promise<RuleRow[]> {
  const rows = await conn.query(
    `SELECT ${RULE_COLUMNS} FROM push_rules
     WHERE localpart = ? AND scope = 'global' AND kind = ?
     ORDER BY priority ASC`,
    [localpart, kind],
  );
  return rows.map(ruleRow);
}

export async function ruleById(
  conn: Conn,
  localpart: string,
  kind: string,
  ruleId: string,
): Promise<RuleRow | null> {
  const rows = await conn.query(
    `SELECT ${RULE_COLUMNS} FROM push_rules
     WHERE localpart = ? AND scope = 'global' AND kind = ? AND rule_id = ?`,
    [localpart, kind, ruleId],
  );
  return rows.length === 0 ? null : ruleRow(rows[0]);
}

export async function putRuleRow(
  conn: Conn,
  localpart: string,
  kind: string,
  ruleId: string,
  priority: number,
  actions: string,
  conditions: string | null,
  pattern: string | null,
  seq: number,
): Promise<void> {
  // An update keeps its enabled state and its old seq (the stream marker
  // is what moves); a new rule is enabled by default.
  await conn.execute(
    `INSERT INTO push_rules
       (localpart, scope, kind, rule_id, priority, actions, conditions, pattern, enabled, is_default, seq)
     VALUES (?, 'global', ?, ?, ?, ?, ?, ?, 1, 0, ?)
     ON CONFLICT (localpart, scope, kind, rule_id) DO UPDATE SET
       priority = excluded.priority,
       actions = excluded.actions,
       conditions = excluded.conditions,
       pattern = excluded.pattern`,
    [localpart, kind, ruleId, priority, actions, conditions, pattern, seq],
  );
}

export async function deleteRuleRow(
  conn: Conn,
  localpart: string,
  kind: string,
  ruleId: string,
): Promise<void> {
  await conn.execute(
    `DELETE FROM push_rules
     WHERE localpart = ? AND scope = 'global' AND kind = ? AND rule_id = ?`,
    [localpart, kind, ruleId],
  );
}

export async function setRuleEnabledRow(
  conn: Conn,
  localpart: string,
  kind: string,
  ruleId: string,
  enabled: boolean,
): Promise<void> {
  await conn.execute(
    `UPDATE push_rules SET enabled = ?
     WHERE localpart = ? AND scope = 'global' AND kind = ? AND rule_id = ?`,
    [enabled ? 1 : 0, localpart, kind, ruleId],
  );
}

export async function setRuleActionsRow(
  conn: Conn,
  localpart: string,
  kind: string,
  ruleId: string,
  actions: string,
): Promise<void> {
  await conn.execute(
    `UPDATE push_rules SET actions = ?
     WHERE localpart = ? AND scope = 'global' AND kind = ? AND rule_id = ?`,
    [actions, localpart, kind, ruleId],
  );
}

export async function setRulePriority(
  conn: Conn,
  localpart: string,
  kind: string,
  ruleId: string,
  priority: number,
): Promise<void> {
  await conn.execute(
    `UPDATE push_rules SET priority = ?
     WHERE localpart = ? AND scope = 'global' AND kind = ? AND rule_id = ?`,
    [priority, localpart, kind, ruleId],
  );
}

// D8: the room-kind rules of one room id, across all localparts (or one).
export async function roomRulesOf(
  conn: Conn,
  roomId: string,
  onlyLocalpart?: string,
): Promise<RuleRow[]> {
  const rows = onlyLocalpart === undefined
    ? await conn.query(
      `SELECT localpart, ${RULE_COLUMNS} FROM push_rules
       WHERE kind = 'room' AND rule_id = ?`,
      [roomId],
    )
    : await conn.query(
      `SELECT localpart, ${RULE_COLUMNS} FROM push_rules
       WHERE kind = 'room' AND rule_id = ? AND localpart = ?`,
      [roomId, onlyLocalpart],
    );
  return rows.map((row) => ({
    ...ruleRow(row),
    localpart: String(row.localpart),
  }));
}

export async function copyRoomRule(
  conn: Conn,
  localpart: string,
  newRoomId: string,
  row: RuleRow,
): Promise<void> {
  // Copy-if-absent: a user's own rule on the new room wins.
  await conn.execute(
    `INSERT INTO push_rules
       (localpart, scope, kind, rule_id, priority, actions, conditions, pattern, enabled, is_default, seq)
     VALUES (?, 'global', 'room', ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (localpart, scope, kind, rule_id) DO NOTHING`,
    [
      localpart,
      newRoomId,
      row.priority,
      row.actions,
      row.conditions,
      row.pattern,
      row.enabled ? 1 : 0,
      row.is_default ? 1 : 0,
    ],
  );
}

// Stamp the user's push-rule stream marker from the shared counter (D10).
export async function stampPushStream(
  conn: Conn,
  localpart: string,
  seq: number,
): Promise<void> {
  await conn.execute(
    `INSERT INTO push_rules_stream (localpart, seq) VALUES (?, ?)
     ON CONFLICT (localpart) DO UPDATE SET seq = excluded.seq`,
    [localpart, seq],
  );
}

// The marker's current position (0 when nothing ever stamped) — the
// m.push_rules emission decision in syncfeed keys on THIS, not the
// combined account-data max.
export async function pushStreamSeqRow(
  conn: Conn,
  localpart: string,
): Promise<number> {
  const rows = await conn.query(
    'SELECT seq FROM push_rules_stream WHERE localpart = ?',
    [localpart],
  );
  return rows.length === 0 || rows[0].seq == null ? 0 : Number(rows[0].seq);
}

// --- tenant-level behaviour --------------------------------------------------

export async function pushStreamSeq(
  tenant: Tenant,
  localpart: string,
): Promise<number> {
  return await tenant.tx((tx) => tx.pushRules.streamSeq(localpart));
}

// The ruleset for GET /pushrules/ (D9): every kind array present,
// priority-ordered within each.
export async function rulesetFor(
  tenant: Tenant,
  localpart: string,
): Promise<Record<PushKind, PushRule[]>> {
  const out = {} as Record<PushKind, PushRule[]>;
  for (const kind of PUSH_KINDS) {
    out[kind] = (await tenant.tx((tx) =>
      tx.pushRules.kindRows(localpart, kind)
    ))
      .map(rowToRule);
  }
  return out;
}

export async function getRule(
  tenant: Tenant,
  localpart: string,
  kind: string,
  ruleId: string,
): Promise<PushRule> {
  const row = await tenant.tx((tx) =>
    tx.pushRules.byId(localpart, kind, ruleId)
  );
  if (row === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'The push rule was not found.');
  }
  return rowToRule(row);
}

// Re-pack a kind's priorities to 100-steps (called when an insert has no
// midpoint left). The new ordering after a re-pack preserves the current
// relative order.
async function repack(
  tx: { pushRules: TenantTxPushRules },
  localpart: string,
  kind: string,
): Promise<void> {
  const rows = await tx.pushRules.kindRows(localpart, kind);
  for (let i = 0; i < rows.length; i++) {
    await tx.pushRules.setPriority(
      localpart,
      kind,
      rows[i].rule_id,
      (i + 1) * 100,
    );
  }
}

type TenantTxPushRules = {
  kindRows(localpart: string, kind: string): Promise<RuleRow[]>;
  setPriority(
    localpart: string,
    kind: string,
    ruleId: string,
    priority: number,
  ): Promise<void>;
};

// PUT /pushrules/global/{kind}/{ruleId} (pushrules.yaml:185-204): create
// or update. `before` makes the rule the next-most-important relative to
// the named rule; `after` the next-less-important; neither puts a NEW
// rule at the top of its kind. New rules are enabled by default. The
// priority computation, the upsert and the stream stamp are one tenant
// transaction.
export async function putRule(
  tenant: Tenant,
  localpart: string,
  kind: string,
  ruleId: string,
  body: { actions: unknown[]; conditions?: unknown[]; pattern?: string },
  placement: { before?: string; after?: string },
): Promise<void> {
  if (ruleId.startsWith('.') || ruleId.includes('/') || ruleId.includes('\\')) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'rule_id may not start with . or contain slashes',
    );
  }
  await tenant.tx(async (tx) => {
    const existing = await tx.pushRules.byId(localpart, kind, ruleId);
    let priority: number;
    if (existing !== null) {
      priority = existing.priority; // an update keeps its place
    } else if (placement.before !== undefined) {
      let anchor = await tx.pushRules.byId(localpart, kind, placement.before);
      if (anchor === null) {
        throw new MatrixError(
          400,
          'M_UNKNOWN',
          'before/after rule not found: ' + placement.before,
        );
      }
      const above = (await tx.pushRules.kindRows(localpart, kind)).filter((r) =>
        r.priority < anchor!.priority
      );
      const floor = above.length > 0
        ? Math.max(...above.map((r) => r.priority))
        : 0;
      if (anchor.priority - floor <= 1) await repack(tx, localpart, kind);
      anchor = (await tx.pushRules.byId(localpart, kind, placement.before))!;
      const above2 = (await tx.pushRules.kindRows(localpart, kind)).filter((
        r,
      ) => r.priority < anchor!.priority);
      const floor2 = above2.length > 0
        ? Math.max(...above2.map((r) => r.priority))
        : 0;
      priority = floor2 + Math.floor((anchor.priority - floor2) / 2);
      if (priority <= floor2) priority = floor2 + 1;
    } else if (placement.after !== undefined) {
      let anchor = await tx.pushRules.byId(localpart, kind, placement.after);
      if (anchor === null) {
        throw new MatrixError(
          400,
          'M_UNKNOWN',
          'before/after rule not found: ' + placement.after,
        );
      }
      const below = (await tx.pushRules.kindRows(localpart, kind)).filter((r) =>
        r.priority > anchor!.priority
      );
      const ceil = below.length > 0
        ? Math.min(...below.map((r) => r.priority))
        : anchor.priority + 200;
      if (ceil - anchor.priority <= 1) await repack(tx, localpart, kind);
      anchor = (await tx.pushRules.byId(localpart, kind, placement.after))!;
      const below2 = (await tx.pushRules.kindRows(localpart, kind)).filter((
        r,
      ) => r.priority > anchor!.priority);
      const ceil2 = below2.length > 0
        ? Math.min(...below2.map((r) => r.priority))
        : anchor.priority + 200;
      priority = anchor.priority + Math.floor((ceil2 - anchor.priority) / 2);
      if (priority <= anchor.priority) priority = anchor.priority + 1;
    } else {
      // the most important user-defined rule of the kind (pushrules.yaml
      // :199-201) — priority 100 when the kind is empty
      const rows = await tx.pushRules.kindRows(localpart, kind);
      priority = rows.length > 0
        ? Math.min(...rows.map((r) => r.priority)) - 100
        : 100;
    }
    // Burns a counter value on updates too — the old nextval-in-VALUES
    // consumed one the same way.
    const seq = await tx.counters.nextStream();
    await tx.pushRules.put(
      localpart,
      kind,
      ruleId,
      priority,
      JSON.stringify(body.actions),
      body.conditions !== undefined ? JSON.stringify(body.conditions) : null,
      body.pattern ?? null,
      seq,
    );
    await tx.pushRules.stampStream(localpart, await tx.counters.nextStream());
  });
}

export async function deleteRule(
  tenant: Tenant,
  localpart: string,
  kind: string,
  ruleId: string,
): Promise<void> {
  await tenant.tx(async (tx) => {
    if ((await tx.pushRules.byId(localpart, kind, ruleId)) === null) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'The push rule was not found.');
    }
    await tx.pushRules.delete(localpart, kind, ruleId);
    // the stream moves even when the table empties (the marker, D10)
    await tx.pushRules.stampStream(localpart, await tx.counters.nextStream());
  });
}

export async function setRuleEnabled(
  tenant: Tenant,
  localpart: string,
  kind: string,
  ruleId: string,
  enabled: boolean,
): Promise<void> {
  await tenant.tx(async (tx) => {
    if ((await tx.pushRules.byId(localpart, kind, ruleId)) === null) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'The push rule was not found.');
    }
    await tx.pushRules.setEnabled(localpart, kind, ruleId, enabled);
    await tx.pushRules.stampStream(localpart, await tx.counters.nextStream());
  });
}

export async function setRuleActions(
  tenant: Tenant,
  localpart: string,
  kind: string,
  ruleId: string,
  actions: unknown[],
): Promise<void> {
  await tenant.tx(async (tx) => {
    if ((await tx.pushRules.byId(localpart, kind, ruleId)) === null) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'The push rule was not found.');
    }
    await tx.pushRules.setActions(
      localpart,
      kind,
      ruleId,
      JSON.stringify(actions),
    );
    await tx.pushRules.stampStream(localpart, await tx.counters.nextStream());
  });
}

// D8: copy every room-kind rule from the old room to the new one for ALL
// local users (the TestPushRuleRoomUpgrade contract — Synapse/Dendrite
// behaviour, room_upgrades.md:81-83's "personalized settings"). Copy, not
// move: the old room's rules stay (the test asserts both). A user's own
// rule on the new room wins (copy-if-absent).
export async function migrateRoomRules(
  tenant: Tenant,
  oldRoomId: string,
  newRoomId: string,
  onlyLocalpart?: string,
): Promise<void> {
  await tenant.tx(async (tx) => {
    const rows = await tx.pushRules.roomRulesOf(oldRoomId, onlyLocalpart);
    const touched = new Set<string>();
    for (const row of rows) {
      await tx.pushRules.copyRoomRule(row.localpart!, newRoomId, row);
      touched.add(row.localpart!);
    }
    for (const lp of touched) {
      await tx.pushRules.stampStream(lp, await tx.counters.nextStream());
    }
  });
}
