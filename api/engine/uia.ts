// api/engine/uia.ts — shared User-Interactive Authentication (UIA) helper,
// used by register (dummy flow) and the account endpoints (password flow).
//
// Spec v1.11, Client-Server API § "User-Interactive Authentication API >
// User-interactive API in the REST API" (transcribed, not recalled):
// - "A client should first make a request with no `auth` parameter. The
//    homeserver returns an HTTP 401 response, with a JSON body" containing
//    `flows`, `params`, `session`.
// - "If the homeserver deems the authentication attempt to be successful
//    but still requires more stages to be completed, it returns HTTP
//    status 401 along with the same object as when no authentication was
//    attempted, with the addition of the `completed` key which is an
//    array of auth types the client has completed successfully".
// - "If the homeserver decides that an attempt on a stage was
//    unsuccessful, but the client may make a second attempt, it returns
//    the same HTTP status 401 response as above, with the addition of the
//    standard `errcode` and `error` fields describing the error."
// - "A request to an endpoint that uses User-Interactive Authentication
//    never succeeds without auth. Homeservers may allow requests that
//    don't require auth by offering a stage with only the `m.login.dummy`
//    auth type, but they must still give a 401 response to requests with
//    no auth data."
// The server indicates what authentication data it requires via the body
// of an HTTP 401 response; the client submits that data via the `auth`
// request parameter (auth dict: { type, session?, identifier?, password?,
// … }); the client is free to choose which flow it follows, and a flow is
// complete when all of its stages are completed.
import { MatrixError } from './matrix-error.ts';
import { localpartOf } from './auth.ts';
import {
  completeUiaStages,
  createUiaSession,
  dropUiaSession,
  getUiaSession,
  verifyUserPassword,
  type UiaSession,
} from './tenant.ts';

export const PASSWORD_FLOWS = [{ stages: ['m.login.password'] }];
export const DUMMY_FLOWS = [{ stages: ['m.login.dummy'] }];

/** The rule-2/rule-5 401: flows + params + session (+ completed when a
 * completion attempt happened). `MatrixError`'s 4th argument replaces the
 * body wholesale, so no errcode/error keys ride along unless given. */
function uiaRequired(
  session: UiaSession,
  flows: { stages: string[] }[],
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
export async function requireUia(opts: {
  serverName: string;
  body: Record<string, unknown>; // already-parsed JSON body ({} if none)
  flows: { stages: string[] }[];
  /** the authenticated caller (@u:server) for password endpoints; undefined for register */
  caller?: string;
}): Promise<void> {
  const { serverName, body, flows, caller } = opts;

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
    ? await getUiaSession(serverName, sessionId)
    : null;

  // Rule 2: no auth.type → create session (when absent), throw the
  // three-key 401 (flows, params, session — no errcode).
  if (authType === undefined) {
    if (session === null) session = await createUiaSession(serverName, flows);
    throw uiaRequired(session, flows, false);
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
        const rest = lower.slice(1);
        const colon = rest.lastIndexOf(':');
        if (colon >= 0) {
          targetLocalpart = rest.slice(0, colon);
          targetMxid = `@${rest}`;
        }
      } else {
        targetLocalpart = lower;
        targetMxid = `@${lower}:${serverName}`;
      }
    }
    // Caller check fires BEFORE any password verification (order matters —
    // never leak whether another user's password was right).
    if (caller !== undefined && targetMxid !== undefined && targetMxid !== caller) {
      throw new MatrixError(
        403,
        'M_FORBIDDEN',
        'auth identifier does not match the authenticated user',
      );
    }
    const target = targetLocalpart ??
      (caller !== undefined ? localpartOf(caller) : undefined);
    const password = typeof auth.password === 'string' && auth.password.length > 0
      ? auth.password
      : undefined;
    if (target !== undefined && password !== undefined) {
      const ok = await verifyUserPassword(serverName, target, password);
      if (!ok) {
        // Rule 4: session (existing or fresh) kept; the 401 carries the
        // failed attempt's fields (Complement A1 :129-199 step 3, A6 :76-86).
        if (session === null) session = await createUiaSession(serverName, flows);
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
      const fresh = await createUiaSession(serverName, flows);
      throw uiaRequired(fresh, flows, false);
    }
    // Rule 6: one-shot — no session anywhere; create + complete + drop in
    // the same call (A4/A6 send no session). Without a completed attempt,
    // a fresh session answers the rule-5 401.
    if (newly.length === 0) {
      const fresh = await createUiaSession(serverName, flows);
      throw uiaRequired(fresh, flows, true);
    }
    const s = await createUiaSession(serverName, flows);
    const updated = await completeUiaStages(serverName, s.session, newly);
    if (!completesAFlow(updated.completed)) {
      throw uiaRequired(updated, flows, true);
    }
    await dropUiaSession(serverName, updated.session);
    return;
  }

  const updated = newly.length > 0
    ? await completeUiaStages(serverName, session.session, newly)
    : session;
  if (!completesAFlow(updated.completed)) {
    throw uiaRequired(updated, flows, true);
  }
  await dropUiaSession(serverName, updated.session);
}