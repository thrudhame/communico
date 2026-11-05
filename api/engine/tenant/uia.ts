// api/engine/tenant/uia.ts — User-Interactive Authentication: persisted
// sessions (a restart mid-flow degrades to a client retry, never to a
// half-registered user) and the shared requireUia helper with the six
// rules of plan §3.3 (doltgres:api/engine/uia.ts), used by register
// (dummy flow) and the account endpoints (password flow).
import type { Conn } from '#engine/store/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { localpartOf } from '#engine/tenant/auth.ts';
import { splitId } from '#engine/ids.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { verifyUserPassword } from '#engine/tenant/users.ts';

export const PASSWORD_FLOWS = [{ stages: ['m.login.password'] }];
export const DUMMY_FLOWS = [{ stages: ['m.login.dummy'] }];

export type UiaSession = {
  session: string;
  flows: { stages: string[] }[];
  completed: string[];
};

// --- conn-level rows (bound on TenantTx) -----------------------------------

export async function insertUiaSession(
  conn: Conn,
  session: string,
  flows: { stages: string[] }[],
): Promise<void> {
  await conn.execute(
    'INSERT INTO uia_sessions (session, flows, completed, created_ms) VALUES (?, ?, ?, ?)',
    [session, JSON.stringify(flows), '[]', Date.now()],
  );
}

export async function uiaSessionById(
  conn: Conn,
  session: string,
): Promise<UiaSession | null> {
  const rows = await conn.query(
    'SELECT flows, completed FROM uia_sessions WHERE session = ?',
    [session],
  );
  if (rows.length === 0) return null;
  return {
    session,
    flows: JSON.parse(String(rows[0].flows)) as { stages: string[] }[],
    completed: JSON.parse(String(rows[0].completed)) as string[],
  };
}

export async function completeUiaSessionStages(
  conn: Conn,
  session: string,
  stages: string[],
): Promise<UiaSession> {
  const current = await uiaSessionById(conn, session);
  if (current === null) throw new Error('no such UIA session: ' + session);
  const completed = new Set<string>(current.completed);
  for (const stage of stages) completed.add(stage);
  const arr = [...completed];
  await conn.execute(
    'UPDATE uia_sessions SET completed = ? WHERE session = ?',
    [JSON.stringify(arr), session],
  );
  return { session, flows: current.flows, completed: arr };
}

export async function deleteUiaSession(
  conn: Conn,
  session: string,
): Promise<void> {
  await conn.execute('DELETE FROM uia_sessions WHERE session = ?', [session]);
}

// --- tenant-level wrappers (one tx each) -------------------------------------

export async function createUiaSession(
  tenant: Tenant,
  flows: { stages: string[] }[],
): Promise<UiaSession> {
  const session = crypto.randomUUID().replaceAll('-', '');
  await tenant.tx((tx) => tx.uia.insert(session, flows));
  return { session, flows, completed: [] };
}

export async function getUiaSession(
  tenant: Tenant,
  session: string,
): Promise<UiaSession | null> {
  return await tenant.tx((tx) => tx.uia.byId(session));
}

export async function completeUiaStages(
  tenant: Tenant,
  session: string,
  stages: string[],
): Promise<UiaSession> {
  return await tenant.tx((tx) => tx.uia.complete(session, stages));
}

export async function dropUiaSession(
  tenant: Tenant,
  session: string,
): Promise<void> {
  await tenant.tx((tx) => tx.uia.drop(session));
}

// --- the shared helper -------------------------------------------------------

/** The rule-2/rule-5 401: flows + params + session (+ completed when a
 * completion attempt happened). `MatrixError`'s 4th argument replaces the
 * body wholesale, so no errcode/error keys ride along unless given. */
function uiaRequired(
  session: UiaSession,
  withCompleted: boolean,
): MatrixError {
  const body: Record<string, unknown> = {
    flows: session.flows,
    params: {},
    session: session.session,
  };
  if (withCompleted) body.completed = session.completed;
  return new MatrixError(401, 'M_UNAUTHORIZED', 'auth required', body);
}

function hasStage(flows: { stages: string[] }[], stage: string): boolean {
  return flows.some((f) => f.stages.includes(stage));
}

/** Throws the UIA 401 until a flow is complete; returns when it is. */
export async function requireUia(
  tenant: Tenant,
  opts: {
    body: Record<string, unknown>; // already-parsed JSON body ({} if none)
    flows: { stages: string[] }[];
    /** the authenticated caller (@u:server) for password endpoints; undefined for register */
    caller?: string;
  },
): Promise<void> {
  const { body, flows, caller } = opts;

  // Rule 1: auth dict (plain object only); session id from auth.session
  // falling back to a top-level body.session.
  const auth = body.auth !== null && typeof body.auth === 'object' &&
      !Array.isArray(body.auth)
    ? body.auth as Record<string, unknown>
    : {};
  const rawSession: unknown = auth.session ?? body.session;
  const sessionId = typeof rawSession === 'string' ? rawSession : undefined;
  const authType = typeof auth.type === 'string' ? auth.type : undefined;

  let session: UiaSession | null = sessionId !== undefined
    ? await getUiaSession(tenant, sessionId)
    : null;

  // Rule 2: no auth.type → create session (when absent), throw the
  // three-key 401 (flows, params, session — no errcode).
  if (authType === undefined) {
    if (session === null) session = await createUiaSession(tenant, flows);
    throw uiaRequired(session, false);
  }

  // Rules 3-4: earn stages from the attempt.
  let newly: string[] = [];
  if (authType === 'm.login.dummy' && hasStage(flows, 'm.login.dummy')) {
    newly = ['m.login.dummy'];
  } else if (
    authType === 'm.login.password' && hasStage(flows, 'm.login.password')
  ) {
    // Rule 4: identifier validation. Target = the identifier's user, or
    // (absent identifier) the authenticated caller.
    const ident = auth.identifier !== null &&
        typeof auth.identifier === 'object'
      ? auth.identifier as Record<string, unknown>
      : undefined;
    const rawUser = typeof ident?.user === 'string' ? ident.user : undefined;
    let targetLocalpart: string | undefined;
    let targetMxid: string | undefined;
    if (rawUser !== undefined) {
      const lower = rawUser.toLowerCase();
      if (lower.startsWith('@')) {
        const parts = splitId(lower);
        if (parts.server !== null) {
          targetLocalpart = parts.localpart;
          targetMxid = lower;
        }
      } else {
        targetLocalpart = lower;
        targetMxid = `@${lower}:${tenant.serverName}`;
      }
    }
    // Caller check fires BEFORE any password verification (order matters —
    // never leak whether another user's password was right).
    if (
      caller !== undefined && targetMxid !== undefined && targetMxid !== caller
    ) {
      throw new MatrixError(
        403,
        'M_FORBIDDEN',
        'auth identifier does not match the authenticated user',
      );
    }
    const target = targetLocalpart ??
      (caller !== undefined ? localpartOf(caller) : undefined);
    const password =
      typeof auth.password === 'string' && auth.password.length > 0
        ? auth.password
        : undefined;
    if (target !== undefined && password !== undefined) {
      const ok = await verifyUserPassword(tenant, target, password);
      if (!ok) {
        // Rule 4: session (existing or fresh) kept; the 401 carries the
        // failed attempt's fields (Complement A1 :129-199 step 3, A6 :76-86).
        if (session === null) {
          session = await createUiaSession(tenant, flows);
        }
        throw new MatrixError(401, 'M_FORBIDDEN', 'invalid password', {
          errcode: 'M_FORBIDDEN',
          error: 'invalid password',
          flows: session.flows,
          params: {},
          session: session.session,
          completed: [],
        });
      }
      newly = ['m.login.password'];
    }
  }

  // Completion bookkeeping (rule 5): some flow's stages ⊆ completed.
  const completesAFlow = (completed: string[]): boolean =>
    flows.some((f) => f.stages.every((s) => completed.includes(s)));

  if (session === null) {
    // Caller-less UIA (register) requires a persisted session — never
    // one-shot: a dummy attempt with no session gets a fresh-session 401
    // (pre-M2 register behavior, which commit "Shared UIA helper" must
    // preserve; Complement TestRegistration "Registration without a
    // session fails" requires the 401 once the server issues sessions).
    if (caller === undefined) {
      const fresh = await createUiaSession(tenant, flows);
      throw uiaRequired(fresh, false);
    }
    // Rule 6: one-shot — no session anywhere; create + complete + drop in
    // the same call (A4/A6 send no session). Without a completed attempt,
    // a fresh session answers the rule-5 401.
    if (newly.length === 0) {
      const fresh = await createUiaSession(tenant, flows);
      throw uiaRequired(fresh, true);
    }
    const s = await createUiaSession(tenant, flows);
    const updated = await completeUiaStages(tenant, s.session, newly);
    if (!completesAFlow(updated.completed)) {
      throw uiaRequired(updated, true);
    }
    await dropUiaSession(tenant, updated.session);
    return;
  }

  const updated = newly.length > 0
    ? await completeUiaStages(tenant, session.session, newly)
    : session;
  if (!completesAFlow(updated.completed)) {
    throw uiaRequired(updated, true);
  }
  await dropUiaSession(tenant, updated.session);
}
