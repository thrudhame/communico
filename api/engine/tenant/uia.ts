// api/engine/tenant/uia.ts — User-Interactive Authentication: persisted
// sessions (a restart mid-flow degrades to a client retry, never to a
// half-registered user) and the shared requireUia helper with the six
// rules of plan §3.3 (doltgres:api/engine/uia.ts), used by register
// (dummy flow) and the account endpoints (password flow).
import type { Conn } from '#engine/store/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  accessTokenByHash,
  hashToken,
  localpartOf,
} from '#engine/tenant/auth.ts';
import { splitId } from '#engine/ids.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import {
  credentialRevision,
  userByLocalpart,
  verifyUserPassword,
} from '#engine/tenant/users.ts';
import { config } from '#engine/config.ts';
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import {
  accountBarriers,
  registryDevice,
  tenantAuthority,
} from '#engine/tenant/session-authority.ts';
import type { AuthIntent } from '#engine/tenant/ingress.ts';

export const UIA_BINDING_SQL =
  'ALTER TABLE uia_sessions ADD COLUMN binding TEXT;';

export type UiaAction = { name: string; digest: string };
export function uiaAction(name: string, parameters: unknown): UiaAction {
  return {
    name,
    digest: createHash('sha256').update(canonicalJson(parameters)).digest(
      'hex',
    ),
  };
}
type UiaRequest = {
  caller: string;
  action: UiaAction;
  bodyHash: string;
  tokenHash: string | null;
  targets: string[];
};
export type UiaAuthorization = { request: UiaRequest; state: string };
function bindingOf(authorization: UiaAuthorization): string {
  // The current bearer is checked on each request and at mutation, but UIA is
  // bound to its device incarnation, not one access token across a refresh.
  const { tokenHash: _tokenHash, action, ...request } = authorization.request;
  // The keyed body commitment covers action parameters. Do not retain a fast
  // unkeyed digest of a new_password alongside the normal Argon2 verifier.
  return canonicalJson({
    request: { ...request, action: action.name },
    state: authorization.state,
  });
}
type Authorize = (intent: AuthIntent) => Promise<void>;
function bindingChanged(): never {
  throw new MatrixError(403, 'M_FORBIDDEN', 'UIA action or authority changed');
}

/** Capture only semantic authority, not a changing arrival/heartbeat timestamp.
 * This same contract runs before password proof and in the mutation's own tx. */
export async function captureUiaState(
  conn: Conn,
  request: UiaRequest,
  authorize: Authorize,
): Promise<string> {
  const localpart = localpartOf(request.caller);
  await authorize({ kind: 'password', localpart });
  const user = await userByLocalpart(conn, localpart);
  if (!user || user.deactivated) bindingChanged();
  let callerDevice: string | null = null;
  if (request.tokenHash !== null) {
    await authorize({
      kind: 'session',
      hash: request.tokenHash,
      refresh: false,
    });
    const token = await accessTokenByHash(conn, request.tokenHash);
    if (
      !token || token.localpart !== localpart ||
      (token.expires_ms !== null && token.expires_ms <= Date.now())
    ) bindingChanged();
    callerDevice = token.device_id;
  }
  const devices = [];
  for (
    const id of [
      ...new Set([
        ...request.targets,
        ...(callerDevice === null ? [] : [callerDevice]),
      ]),
    ].sort()
  ) {
    const [row] = await conn.query(
      'SELECT generation FROM devices WHERE localpart=? AND device_id=?',
      [localpart, id],
    );
    devices.push([
      id,
      row?.generation ?? null,
      (await registryDevice(conn, localpart, id))?.id ?? null,
    ]);
  }
  const [tenant] = await conn.query(
    'SELECT server_name,native_name FROM tenant',
  );
  if (
    !tenant || request.caller !== '@' + localpart + ':' + tenant.server_name
  ) bindingChanged();
  const [snapshot] = await conn.query(
    'SELECT pairing,grant_revision,owner_revision FROM account_auth_snapshots WHERE localpart=?',
    [localpart],
  );
  const controls = await conn.query(
    'SELECT pairing,revision FROM facade_owner_activation ORDER BY pairing',
  );
  return canonicalJson({
    node: await tenantAuthority(conn) ?? tenant,
    credential: await credentialRevision(conn, localpart),
    barriers: await accountBarriers(conn, localpart),
    snapshot: snapshot ?? null,
    controls,
    callerDevice,
    devices,
  });
}

export async function authorizeUia(
  conn: Conn,
  authorization: UiaAuthorization,
  authorize: Authorize,
  expected?: { localpart: string; action: UiaAction },
): Promise<void> {
  if (
    expected &&
    (localpartOf(authorization.request.caller) !== expected.localpart ||
      canonicalJson(authorization.request.action) !==
        canonicalJson(expected.action))
  ) bindingChanged();
  if (
    await captureUiaState(conn, authorization.request, authorize) !==
      authorization.state
  ) bindingChanged();
}

export const PASSWORD_FLOWS = [{ stages: ['m.login.password'] }];
export const DUMMY_FLOWS = [{ stages: ['m.login.dummy'] }];

export type UiaSession = {
  session: string;
  flows: { stages: string[] }[];
  completed: string[];
  binding?: string | null;
};

// --- conn-level rows (bound on TenantTx) -----------------------------------

export async function insertUiaSession(
  conn: Conn,
  session: string,
  flows: { stages: string[] }[],
  binding: string | null = null,
): Promise<void> {
  const now = Date.now(), limits = config().uia;
  await conn.execute('DELETE FROM uia_sessions WHERE created_ms <= ?', [
    now - limits.sessionseconds * 1000,
  ]);
  const count = await conn.query('SELECT count(*) AS n FROM uia_sessions');
  if (Number(count[0].n) >= limits.maxsessions) {
    throw new MatrixError(
      429,
      'M_LIMIT_EXCEEDED',
      'UIA session capacity reached; retry an existing flow',
    );
  }
  await conn.execute(
    'INSERT INTO uia_sessions (session, flows, completed, created_ms, binding) VALUES (?, ?, ?, ?, ?)',
    [session, JSON.stringify(flows), '[]', now, binding],
  );
}

export async function uiaSessionById(
  conn: Conn,
  session: string,
): Promise<UiaSession | null> {
  const rows = await conn.query(
    'SELECT flows, completed, binding FROM uia_sessions WHERE session = ? AND created_ms > ?',
    [session, Date.now() - config().uia.sessionseconds * 1000],
  );
  if (rows.length === 0) return null;
  return {
    session,
    flows: JSON.parse(String(rows[0].flows)) as { stages: string[] }[],
    completed: JSON.parse(String(rows[0].completed)) as string[],
    binding: rows[0].binding === null ? null : String(rows[0].binding),
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
  return { ...current, completed: arr };
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
  authorization?: UiaAuthorization,
): Promise<UiaSession> {
  const session = crypto.randomUUID().replaceAll('-', '');
  await tenant.tx(async (tx) => {
    if (authorization) await tx.uia.authorize(authorization);
    await tx.uia.insert(
      session,
      flows,
      authorization ? bindingOf(authorization) : null,
    );
  });
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
  authorization?: UiaAuthorization,
): Promise<UiaSession> {
  return await tenant.tx(async (tx) => {
    if (authorization) {
      await tx.uia.authorize(authorization);
      if (
        (await tx.uia.byId(session))?.binding !== bindingOf(authorization)
      ) bindingChanged();
    }
    return await tx.uia.complete(session, stages);
  });
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
type UiaOptions = {
  body: Record<string, unknown>; // already-parsed JSON body ({} if none)
  flows: { stages: string[] }[];
  /** the authenticated caller (@u:server) for password endpoints; undefined for register */
  caller?: string;
  action?: UiaAction;
  token?: string;
  targets?: string[];
};
export function requireUia(
  tenant: Tenant,
  opts: UiaOptions & { caller: string; action: UiaAction },
): Promise<UiaAuthorization>;
export function requireUia(tenant: Tenant, opts: UiaOptions): Promise<void>;
export async function requireUia(
  tenant: Tenant,
  opts: UiaOptions,
): Promise<UiaAuthorization | void> {
  const { body, flows, caller } = opts;
  const parameters = Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== 'auth' && key !== 'session'),
  );
  const action = opts.action ?? uiaAction('', null);
  // Hash a domain-separated deterministic signature, not the secret-bearing
  // parameters themselves. No signature or plaintext is retained or returned.
  const requestCommitment = caller === undefined ? '' : uiaAction(
    'request',
    await tenant.signer().sign(
      canonicalJson({
        kind: 'communico-uia-binding',
        version: 1,
        parameters,
        flows,
        action,
      }),
    ),
  ).digest;
  const request: UiaRequest | undefined = caller === undefined ? undefined : {
    caller,
    action,
    bodyHash: requestCommitment,
    tokenHash: opts.token ? await hashToken(opts.token) : null,
    targets: [...new Set(opts.targets ?? [])].sort(),
  };
  const authorization = request
    ? {
      request,
      state: await tenant.tx((tx) => tx.uia.capture(request)),
    }
    : undefined;

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
  if (
    session &&
    (session.binding ?? null) !==
      (authorization ? bindingOf(authorization) : null)
  ) bindingChanged();

  // Rule 2: no auth.type → create session (when absent), throw the
  // three-key 401 (flows, params, session — no errcode).
  if (authType === undefined) {
    if (session === null) {
      session = await createUiaSession(tenant, flows, authorization);
    }
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
          session = await createUiaSession(tenant, flows, authorization);
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
      const fresh = await createUiaSession(tenant, flows, authorization);
      throw uiaRequired(fresh, false);
    }
    // Rule 6: one-shot — no session anywhere; create + complete + drop in
    // the same call (A4/A6 send no session). Without a completed attempt,
    // a fresh session answers the rule-5 401.
    if (newly.length === 0) {
      const fresh = await createUiaSession(tenant, flows, authorization);
      throw uiaRequired(fresh, true);
    }
    const s = await createUiaSession(tenant, flows, authorization);
    const updated = await completeUiaStages(
      tenant,
      s.session,
      newly,
      authorization,
    );
    if (!completesAFlow(updated.completed)) {
      throw uiaRequired(updated, true);
    }
    await dropUiaSession(tenant, updated.session);
    return authorization;
  }

  const updated = newly.length > 0
    ? await completeUiaStages(tenant, session.session, newly, authorization)
    : session;
  if (!completesAFlow(updated.completed)) {
    throw uiaRequired(updated, true);
  }
  await dropUiaSession(tenant, updated.session);
  return authorization;
}
