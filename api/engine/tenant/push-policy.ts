// Publication policy belongs to one fresh tenant attempt, for its selected set.
// Event evaluation and room context remain with the server publication owner.
import type { Conn } from '#engine/store/db.ts';
import { ruleRow, rulesetFromRows } from '#engine/tenant/pushrules.ts';

export type PublicationPolicy = {
  ignored: Record<string, unknown>;
  rules: ReturnType<typeof rulesetFromRows>;
  ruleRevision: number;
  ignoreRevision: number;
  pusherIncarnations: string[];
};

export async function capturePublicationPolicies(
  conn: Conn,
  serverName: string,
  localparts: readonly string[],
): Promise<Map<string, PublicationPolicy>> {
  if (!localparts.length) return new Map();
  const rows = await conn.query(
    `SELECT u.localpart,a.content,a.seq AS ignore_revision,s.seq AS rule_revision,
      (SELECT json_group_array(json_object('kind',kind,'rule_id',rule_id,
        'priority',priority,'actions',actions,'conditions',conditions,
        'pattern',pattern,'enabled',enabled,'is_default',is_default))
       FROM (SELECT kind,rule_id,priority,actions,conditions,pattern,enabled,is_default
         FROM push_rules WHERE localpart=u.localpart AND scope='global'
         ORDER BY kind,priority)) AS rules,
      (SELECT json_group_array(incarnation) FROM pushers
        WHERE localpart=u.localpart AND kind='http') AS pushers
    FROM json_each(?) selected JOIN users u ON u.localpart=CAST(selected.value AS TEXT)
    LEFT JOIN account_data a ON a.localpart=u.localpart AND a.room_id='' AND a.type='m.ignored_user_list'
    LEFT JOIN push_rules_stream s ON s.localpart=u.localpart
    WHERE u.deactivated=0`,
    [JSON.stringify([...new Set(localparts)])],
  );
  return new Map(rows.map((row) => {
    const lp = String(row.localpart);
    const ignored = row.content === null
      ? undefined
      : JSON.parse(String(row.content));
    const stored = JSON.parse(String(row.rules)) as Record<string, unknown>[];
    return [lp, {
      ignored: ignored?.ignored_users ?? {},
      rules: rulesetFromRows(
        lp,
        serverName,
        stored.map((r) => ({
          ...ruleRow(r),
          kind: String(r.kind),
        })),
      ),
      ruleRevision: Number(row.rule_revision ?? 0),
      ignoreRevision: Number(row.ignore_revision ?? 0),
      pusherIncarnations: JSON.parse(String(row.pushers)) as string[],
    }];
  }));
}
