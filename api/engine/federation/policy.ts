// Effective federation decisions belong to the logical server. Node-local TLS,
// ports and transport tuning are not home policy and never enter this projection.
import { config } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Conn } from '#engine/store/db.ts';

export const FEDERATION_POLICY_SQL = `
CREATE TABLE federation_policy(singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1), policy_json TEXT NOT NULL);
`;

export type FederationPolicy = {
  enabled: boolean;
  mode: string;
  keychange: string;
  witnesses: number;
  keyfailminutes: number;
  keyvalidityhours: number;
  paused: string[];
};

export function policyOf(raw: unknown): FederationPolicy {
  const bad = (): never => {
    throw new MatrixError(400, 'M_BAD_JSON', 'invalid federation policy');
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad();
  const v = raw as Record<string, unknown>;
  if (
    typeof v.enabled !== 'boolean' ||
    !['open', 'closed'].includes(String(v.mode)) ||
    !['accept', 'warn', 'block'].includes(String(v.keychange)) ||
    !['witnesses', 'keyfailminutes', 'keyvalidityhours'].every((key) =>
      typeof v[key] === 'number' && Number.isFinite(v[key]) &&
      Number(v[key]) >= 0
    ) || !Number.isSafeInteger(v.witnesses) ||
    Number(v.keyvalidityhours) <= 0 ||
    !Array.isArray(v.paused) ||
    v.paused.some((name) => typeof name !== 'string' || !name) ||
    new Set(v.paused).size !== v.paused.length
  ) return bad();
  return {
    enabled: v.enabled,
    mode: String(v.mode),
    keychange: String(v.keychange),
    witnesses: Number(v.witnesses),
    keyfailminutes: Number(v.keyfailminutes),
    keyvalidityhours: Number(v.keyvalidityhours),
    paused: v.paused as string[],
  };
}

export async function exportFederationPolicy(
  db: Pick<Conn, 'query'>,
): Promise<FederationPolicy> {
  const f = config().federation;
  return {
    enabled: f.enabled,
    mode: f.mode,
    keychange: f.keychange,
    witnesses: f.witnesses,
    keyfailminutes: f.keyfailminutes,
    keyvalidityhours: f.keyvalidityhours,
    paused: (await db.query(
      "SELECT DISTINCT server_name FROM server_key_changes WHERE status='blocking' ORDER BY server_name",
    )).map((row) => String(row.server_name)),
  };
}

export async function federationPolicy(
  db: Pick<Conn, 'query'>,
): Promise<FederationPolicy> {
  if (config().server.role !== 'facade') {
    return await exportFederationPolicy(db);
  }
  const [row] = await db.query(
    'SELECT policy_json FROM federation_policy WHERE singleton=1',
  );
  if (!row) {
    throw new MatrixError(503, 'M_UNAVAILABLE', 'federation policy not ready');
  }
  return policyOf(JSON.parse(String(row.policy_json)));
}
