// api/engine/pushrules.ts — the push-rules store (plan D9): the table
// behind /pushrules; m.push_rules is SYNTHESISED from it on read, never
// stored as account_data. Priorities are internal ordering only (lower =
// more important, 100-step with midpoint inserts and a re-pack when the
// gap closes). Spec default rules (.m.rule.*) are not seeded here — the
// push milestone (plan §8). The push_rules_stream marker is the stream:
// EVERY mutation stamps it (so a delete that empties the table still
// moves the token's _a<n>).
import { serverName } from './config.ts';
import { MatrixError } from './matrix-error.ts';
import { withDb } from './db.ts';
import { ensureTenant } from './tenant.ts';

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

// Stamp the user's push-rule stream marker (D10).
async function stampPushStream(localpart: string): Promise<void> {
  const { dbName } = await ensureTenant(serverName());
  await withDb(dbName, async (c) => {
    await c.query(
      `INSERT INTO push_rules_stream (localpart, seq) VALUES ($1, nextval('account_data_seq'))
       ON CONFLICT (localpart) DO UPDATE SET seq = nextval('account_data_seq');`,
      [localpart],
    );
  });
}

// The marker's current position (0 when nothing ever stamped) — the
// m.push_rules emission decision in syncfeed keys on THIS, not the
// combined account-data max.
export async function pushStreamSeq(localpart: string): Promise<number> {
  const { dbName } = await ensureTenant(serverName());
  return await withDb(dbName, async (c) => {
    const r = await c.query(
      'SELECT seq AS m FROM push_rules_stream WHERE localpart = $1;',
      [localpart],
    );
    return r.rows.length === 0 || r.rows[0].m == null ? 0 : Number(r.rows[0].m);
  });
}

export interface PushRule {
  rule_id: string;
  actions: unknown[];
  default: boolean;
  enabled: boolean;
  conditions?: unknown[];
  pattern?: string;
}

interface RuleRow {
  rule_id: string;
  priority: number;
  actions: string;
  conditions: string | null;
  pattern: string | null;
  enabled: boolean;
  is_default: boolean;
}

function rowToRule(row: RuleRow): PushRule {
  const rule: PushRule = {
    rule_id: row.rule_id,
    actions: JSON.parse(row.actions) as unknown[],
    default: row.is_default === true,
    enabled: row.enabled === true,
  };
  if (row.conditions !== null) {
    rule.conditions = JSON.parse(row.conditions) as unknown[];
  }
  if (row.pattern !== null) rule.pattern = row.pattern;
  return rule;
}

async function kindRows(
  localpart: string,
  kind: string,
): Promise<RuleRow[]> {
  const { dbName } = await ensureTenant(serverName());
  return await withDb(dbName, async (c) => {
    const r = await c.query(
      `SELECT rule_id, priority, actions, conditions, pattern, enabled, is_default
       FROM push_rules
       WHERE localpart = $1 AND scope = 'global' AND kind = $2
       ORDER BY priority ASC;`,
      [localpart, kind],
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => ({
      rule_id: String(row.rule_id),
      priority: Number(row.priority),
      actions: String(row.actions),
      conditions: row.conditions == null ? null : String(row.conditions),
      pattern: row.pattern == null ? null : String(row.pattern),
      enabled: row.enabled === true,
      is_default: row.is_default === true,
    }));
  });
}

// The ruleset for GET /pushrules/ (D9): every kind array present,
// priority-ordered within each.
export async function rulesetFor(
  localpart: string,
): Promise<Record<PushKind, PushRule[]>> {
  const out = {} as Record<PushKind, PushRule[]>;
  for (const kind of PUSH_KINDS) {
    out[kind] = (await kindRows(localpart, kind)).map(rowToRule);
  }
  return out;
}

async function getRuleRow(
  localpart: string,
  kind: string,
  ruleId: string,
): Promise<RuleRow | null> {
  const { dbName } = await ensureTenant(serverName());
  return await withDb(dbName, async (c) => {
    const r = await c.query(
      `SELECT rule_id, priority, actions, conditions, pattern, enabled, is_default
       FROM push_rules
       WHERE localpart = $1 AND scope = 'global' AND kind = $2 AND rule_id = $3;`,
      [localpart, kind, ruleId],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      rule_id: String(row.rule_id),
      priority: Number(row.priority),
      actions: String(row.actions),
      conditions: row.conditions == null ? null : String(row.conditions),
      pattern: row.pattern == null ? null : String(row.pattern),
      enabled: row.enabled === true,
      is_default: row.is_default === true,
    };
  });
}

export async function getRule(
  localpart: string,
  kind: string,
  ruleId: string,
): Promise<PushRule> {
  const row = await getRuleRow(localpart, kind, ruleId);
  if (row === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'The push rule was not found.');
  }
  return rowToRule(row);
}

// Re-pack a kind's priorities to 100-steps (called when an insert has no
// midpoint left). The new ordering after a re-pack preserves the current
// relative order.
async function repack(localpart: string, kind: string): Promise<void> {
  const rows = await kindRows(localpart, kind);
  const { dbName } = await ensureTenant(serverName());
  await withDb(dbName, async (c) => {
    for (let i = 0; i < rows.length; i++) {
      await c.query(
        `UPDATE push_rules SET priority = $4
         WHERE localpart = $1 AND scope = 'global' AND kind = $2 AND rule_id = $3;`,
        [localpart, kind, rows[i].rule_id, (i + 1) * 100],
      );
    }
  });
}

// PUT /pushrules/global/{kind}/{ruleId} (pushrules.yaml:185-204): create
// or update. `before` makes the rule the next-most-important relative to
// the named rule; `after` the next-less-important; neither puts a NEW
// rule at the top of its kind. New rules are enabled by default.
export async function putRule(
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
  const existing = await getRuleRow(localpart, kind, ruleId);
  let priority: number;
  if (existing !== null) {
    priority = existing.priority; // an update keeps its place
  } else if (placement.before !== undefined) {
    const anchor = await getRuleRow(localpart, kind, placement.before);
    if (anchor === null) {
      throw new MatrixError(
        400,
        'M_UNKNOWN',
        'before/after rule not found: ' + placement.before,
      );
    }
    const above = (await kindRows(localpart, kind)).filter((r) =>
      r.priority < anchor.priority
    );
    const floor = above.length > 0
      ? Math.max(...above.map((r) => r.priority))
      : 0;
    if (anchor.priority - floor <= 1) await repack(localpart, kind);
    const a2 = await getRuleRow(localpart, kind, placement.before);
    const above2 = (await kindRows(localpart, kind)).filter((r) =>
      r.priority < a2!.priority
    );
    const floor2 = above2.length > 0
      ? Math.max(...above2.map((r) => r.priority))
      : 0;
    priority = floor2 + Math.floor((a2!.priority - floor2) / 2);
    if (priority <= floor2) priority = floor2 + 1;
  } else if (placement.after !== undefined) {
    const anchor = await getRuleRow(localpart, kind, placement.after);
    if (anchor === null) {
      throw new MatrixError(
        400,
        'M_UNKNOWN',
        'before/after rule not found: ' + placement.after,
      );
    }
    const below = (await kindRows(localpart, kind)).filter((r) =>
      r.priority > anchor.priority
    );
    const ceil = below.length > 0
      ? Math.min(...below.map((r) => r.priority))
      : anchor.priority + 200;
    if (ceil - anchor.priority <= 1) await repack(localpart, kind);
    const a2 = await getRuleRow(localpart, kind, placement.after);
    const below2 = (await kindRows(localpart, kind)).filter((r) =>
      r.priority > a2!.priority
    );
    const ceil2 = below2.length > 0
      ? Math.min(...below2.map((r) => r.priority))
      : a2!.priority + 200;
    priority = a2!.priority + Math.floor((ceil2 - a2!.priority) / 2);
    if (priority <= a2!.priority) priority = a2!.priority + 1;
  } else {
    // the most important user-defined rule of the kind (pushrules.yaml
    // :199-201) — priority 0 when the kind is empty
    const rows = await kindRows(localpart, kind);
    priority = rows.length > 0
      ? Math.min(...rows.map((r) => r.priority)) - 100
      : 100;
  }

  const { dbName } = await ensureTenant(serverName());
  await withDb(dbName, async (c) => {
    await c.query(
      `INSERT INTO push_rules
         (localpart, scope, kind, rule_id, priority, actions, conditions, pattern, enabled, is_default, seq)
       VALUES ($1, 'global', $2, $3, $4, $5, $6, $7, $8, FALSE, nextval('account_data_seq'))
       ON CONFLICT (localpart, scope, kind, rule_id) DO UPDATE SET
         priority = EXCLUDED.priority,
         actions = EXCLUDED.actions,
         conditions = EXCLUDED.conditions,
         pattern = EXCLUDED.pattern;`,
      [
        localpart,
        kind,
        ruleId,
        priority,
        JSON.stringify(body.actions),
        body.conditions !== undefined ? JSON.stringify(body.conditions) : null,
        body.pattern ?? null,
        existing === null ? true : existing.enabled,
      ],
    );
  });
  await stampPushStream(localpart);
}

export async function deleteRule(
  localpart: string,
  kind: string,
  ruleId: string,
): Promise<void> {
  if ((await getRuleRow(localpart, kind, ruleId)) === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'The push rule was not found.');
  }
  const { dbName } = await ensureTenant(serverName());
  await withDb(dbName, async (c) => {
    await c.query(
      `DELETE FROM push_rules
       WHERE localpart = $1 AND scope = 'global' AND kind = $2 AND rule_id = $3;`,
      [localpart, kind, ruleId],
    );
  });
  // the stream moves even when the table empties (the marker, D10)
  await stampPushStream(localpart);
}

export async function setRuleEnabled(
  localpart: string,
  kind: string,
  ruleId: string,
  enabled: boolean,
): Promise<void> {
  if ((await getRuleRow(localpart, kind, ruleId)) === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'The push rule was not found.');
  }
  const { dbName } = await ensureTenant(serverName());
  await withDb(dbName, async (c) => {
    await c.query(
      `UPDATE push_rules SET enabled = $4
       WHERE localpart = $1 AND scope = 'global' AND kind = $2 AND rule_id = $3;`,
      [localpart, kind, ruleId, enabled],
    );
  });
  await stampPushStream(localpart);
}

export async function setRuleActions(
  localpart: string,
  kind: string,
  ruleId: string,
  actions: unknown[],
): Promise<void> {
  if ((await getRuleRow(localpart, kind, ruleId)) === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'The push rule was not found.');
  }
  const { dbName } = await ensureTenant(serverName());
  await withDb(dbName, async (c) => {
    await c.query(
      `UPDATE push_rules SET actions = $4
       WHERE localpart = $1 AND scope = 'global' AND kind = $2 AND rule_id = $3;`,
      [localpart, kind, ruleId, JSON.stringify(actions)],
    );
  });
  await stampPushStream(localpart);
}

// D8: copy every room-kind rule from the old room to the new one for ALL
// local users (the TestPushRuleRoomUpgrade contract — Synapse/Dendrite
// behaviour, room_upgrades.md:81-83's "personalized settings"). Copy, not
// move: the old room's rules stay (the test asserts both). A user's own
// rule on the new room wins (copy-if-absent).
export async function migrateRoomRules(
  oldRoomId: string,
  newRoomId: string,
  onlyLocalpart?: string,
): Promise<void> {
  const { dbName } = await ensureTenant(serverName());
  const localparts = await withDb(dbName, async (c) => {
    await c.query(
      `INSERT INTO push_rules
         (localpart, scope, kind, rule_id, priority, actions, conditions, pattern, enabled, is_default, seq)
       SELECT localpart, scope, kind, $2, priority, actions, conditions, pattern, enabled, is_default, NULL
       FROM push_rules
       WHERE kind = 'room' AND rule_id = $1 ${
        onlyLocalpart !== undefined ? 'AND localpart = $3' : ''
      }
       ON CONFLICT (localpart, scope, kind, rule_id) DO NOTHING;`,
      onlyLocalpart !== undefined
        ? [oldRoomId, newRoomId, onlyLocalpart]
        : [oldRoomId, newRoomId],
    );
    const r = await c.query(
      `SELECT DISTINCT localpart FROM push_rules WHERE kind = 'room' AND rule_id = $2;`,
      [newRoomId],
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => String(row.localpart));
  });
  for (const lp of localparts) await stampPushStream(lp);
}
