// Tenant-authoritative pusher registrations and incarnationed lifecycle log.
// Every deletion uses this owner, including device/token/account revocation.
import type { Conn } from '#engine/store/db.ts';
import { hashToken } from '#engine/tenant/auth.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { validatePusher } from '#engine/push/registration.ts';
import {
  assertSessionAuthorityOwner,
  captureRetainedSessionAuthorities,
  ownerUnavailable,
  requireSessionAuthority,
  retainedSessionAuthority,
  tenantAuthority,
} from '#engine/tenant/session-authority.ts';
import {
  importRegisterOperation,
  readRegister,
  registerJson,
  type RegisterOperation,
  registerOperationFromRow,
  registerOperations,
  type RegisterView,
  registerView,
  writeRegister,
} from '#engine/facade/registers.ts';
import type { DomainHistoryProof } from '#engine/facade/domain-control.ts';
import { LinkError } from '#engine/facade/protocol.ts';
import { requireTenantDomainSource } from './domain-source.ts';

/** Protected recovery facts are intentionally separate from executable rows. */
export async function pusherOperations(conn: Conn, localpart: string) {
  const keys = await conn.query(
    "SELECT DISTINCT semantic_key FROM domain_operations WHERE kind='pusher' AND json_extract(semantic_key,'$[1]')=? ORDER BY semantic_key",
    [localpart],
  );
  const result: RegisterOperation[] = [];
  for (const row of keys) {
    result.push(...await registerOperations(conn, String(row.semantic_key)));
  }
  return result;
}

export async function pusherChoiceOperations(conn: Conn, localpart: string) {
  const result: RegisterOperation[] = [];
  for (
    const row of await conn.query(
      "SELECT DISTINCT semantic_key FROM domain_operations WHERE kind='pusher-choice' AND json_extract(semantic_key,'$[1]')=? ORDER BY semantic_key",
      [localpart],
    )
  ) result.push(...await registerOperations(conn, String(row.semantic_key)));
  return result;
}

function choiceKey(localpart: string, appId: string, pushkey: string) {
  return JSON.stringify(['pusher-choice', localpart, appId, pushkey]);
}

/** A choice references one immutable source put, not its mutable refresh winner.
 * The reference binds the issuer and semantic key even before its fact arrives. */
function pusherChoice(operation: RegisterOperation) {
  let key: unknown, value: unknown, reference: unknown;
  try {
    key = JSON.parse(operation.semanticKey);
    value = JSON.parse(operation.payload);
    reference = value === null ? null : JSON.parse(value as string);
  } catch {
    throw new Error('invalid pusher choice');
  }
  if (
    !Array.isArray(key) || key.length !== 4 || key[0] !== 'pusher-choice' ||
    !key.every((part) => typeof part === 'string') || !key[1] ||
    JSON.stringify(key) !== operation.semanticKey ||
    operation.kind !== 'pusher-choice'
  ) {
    throw new Error('invalid pusher choice');
  }
  let registrationKey: string | null = null, incarnation: string | null = null;
  if (value !== null) {
    if (
      typeof value !== 'string' || !Array.isArray(reference) ||
      reference.length !== 4 ||
      reference[0] !== operation.source ||
      reference[1] !== operation.incarnation ||
      typeof reference[2] !== 'string' ||
      !reference[2].startsWith('register:') ||
      !Number.isSafeInteger(reference[3]) || reference[3] < 1 ||
      JSON.stringify(reference) !== value
    ) {
      throw new Error('invalid pusher choice');
    }
    let target: unknown;
    try {
      target = JSON.parse(reference[2].slice('register:'.length));
    } catch {
      throw new Error('invalid pusher choice');
    }
    if (
      !Array.isArray(target) || target.length !== 5 || target[0] !== 'pusher' ||
      target.slice(1, 4).some((part, i) => part !== key[i + 1]) ||
      typeof target[4] !== 'string' || !/^[a-f0-9-]{36}$/.test(target[4]) ||
      'register:' + JSON.stringify(target) !== reference[2]
    ) {
      throw new Error('invalid pusher choice');
    }
    registrationKey = reference[2].slice('register:'.length);
    incarnation = target[4];
  }
  return {
    key: key as string[],
    value: value as string | null,
    registrationKey,
    incarnation,
  };
}

async function recordPusherChoice(
  conn: Conn,
  row: Record<string, unknown>,
  deleted = false,
) {
  const authority = await tenantAuthority(conn);
  if (!authority) return;
  let reference: string | null = null;
  if (!deleted) {
    const key = JSON.stringify([
      'pusher',
      row.localpart,
      row.app_id,
      row.pushkey,
      row.incarnation,
    ]);
    const put = (await readRegister(conn, key)).winner;
    if (
      !put || put.payload === 'null' || put.source !== authority.node ||
      put.incarnation !== authority.incarnation
    ) {
      throw new Error('pusher selection source unavailable');
    }
    reference = put.operationId;
  }
  await writeRegister(
    conn,
    { source: authority.node, incarnation: authority.incarnation },
    choiceKey(String(row.localpart), String(row.app_id), String(row.pushkey)),
    'pusher-choice',
    JSON.stringify(reference),
  );
}

type PusherSelection = {
  ready: boolean;
  incarnation?: string;
  value?: NonNullable<ReturnType<typeof pusherOperation>['value']>;
};

type SelectionReader = {
  deactivated: (localpart: string) => boolean | Promise<boolean>;
  register: (key: string) => RegisterView | Promise<RegisterView>;
  operations: (
    key: string,
  ) => RegisterOperation[] | Promise<RegisterOperation[]>;
  keys: (
    localpart: string,
    appId: string,
    pushkey: string,
  ) => string[] | Promise<string[]>;
  native: (
    localpart: string,
    appId: string,
    pushkey: string,
  ) => boolean | Promise<boolean>;
  session: (
    hash: string,
  ) =>
    | Awaited<ReturnType<typeof retainedSessionAuthority>>
    | ReturnType<typeof retainedSessionAuthority>;
};

function selectionReader(conn: Conn): SelectionReader {
  return {
    deactivated: async (lp) =>
      (await conn.query('SELECT deactivated FROM users WHERE localpart=?', [
        lp,
      ]))[0]?.deactivated === 1,
    register: (key) => readRegister(conn, key),
    operations: (key) => registerOperations(conn, key),
    keys: async (lp, appId, pushkey) =>
      (await conn.query(
        "SELECT DISTINCT semantic_key FROM domain_operations WHERE kind='pusher' AND json_extract(semantic_key,'$[1]')=? AND json_extract(semantic_key,'$[2]')=? AND json_extract(semantic_key,'$[3]')=?",
        [lp, appId, pushkey],
      )).map((row) => String(row.semantic_key)),
    native: async (lp, appId, pushkey) =>
      !!(await conn.query(
        'SELECT 1 FROM pushers WHERE localpart=? AND app_id=? AND pushkey=?',
        [lp, appId, pushkey],
      )).length,
    session: (hash) => retainedSessionAuthority(conn, hash, false),
  };
}

/** One verdict for public recovery reads, target enumeration and last send
 * admission. Removal never chooses the next retained contender. */
async function selectedPusher(
  conn: Conn,
  localpart: string,
  appId: string,
  pushkey: string,
  reader: SelectionReader = selectionReader(conn),
): Promise<PusherSelection> {
  if (await reader.deactivated(localpart)) return { ready: true };
  const view = await reader.register(choiceKey(localpart, appId, pushkey));
  if (view.pending.length) return { ready: false };
  if (!view.winner) {
    // An observed removal may arrive without any choice/put. It cannot select
    // a sender; completely fenced old registrations need no active choice.
    for (const key of await reader.keys(localpart, appId, pushkey)) {
      if (
        !(await reader.operations(key)).some((op) => op.payload === 'null')
      ) return { ready: false };
    }
    return { ready: !await reader.native(localpart, appId, pushkey) };
  }
  const choice = pusherChoice(view.winner);
  if (choice.value === null) return { ready: true };
  const operations = await reader.operations(choice.registrationKey!);
  const original = operations.find((op) => op.operationId === choice.value);
  if (!original) return { ready: false };
  if (!pusherOperation(original).value) {
    throw new Error('pusher choice references removal');
  }
  if (operations.some((op) => op.payload === 'null')) return { ready: true };
  const current = await reader.register(choice.registrationKey!);
  if (current.pending.length || !current.winner) return { ready: false };
  const value = pusherOperation(current.winner).value!;
  try {
    const session = await reader.session(value.accessHash);
    if (!session) return { ready: false };
  } catch (error) {
    if (!(error instanceof MatrixError) || error.status !== 401) throw error;
    return { ready: true };
  }
  return { ready: true, incarnation: choice.incarnation!, value };
}

async function validatePusherChoiceReference(
  conn: Conn,
  operation: RegisterOperation,
) {
  const choice = pusherChoice(operation);
  if (choice.value === null) return true;
  const original = (await registerOperations(conn, choice.registrationKey!))
    .find((op) => op.operationId === choice.value);
  if (!original) return false;
  if (!pusherOperation(original).value) {
    throw new Error('pusher choice references removal');
  }
  return true;
}

/** Import can cancel native execution, never instantiate a foreign sender or
 * mint a new semantic fact. Missing dependencies fence sends until recovered. */
async function reconcilePusherChoice(
  conn: Conn,
  localpart: string,
  appId: string,
  pushkey: string,
) {
  const selected = await selectedPusher(conn, localpart, appId, pushkey);
  if (!selected.ready) return false;
  const rows = await conn.query(
    'SELECT * FROM pushers WHERE localpart=? AND app_id=? AND pushkey=?',
    [localpart, appId, pushkey],
  );
  let changed = false;
  for (const row of rows) {
    if (row.incarnation === selected.incarnation) continue;
    await recordPusherChange(conn, row, true);
    await conn.execute(
      'DELETE FROM pushers WHERE localpart=? AND app_id=? AND pushkey=? AND incarnation=?',
      [localpart, appId, pushkey, row.incarnation],
    );
    changed = true;
  }
  return changed;
}

export async function importPusherChoice(
  conn: Conn,
  operation: RegisterOperation,
  history?: DomainHistoryProof,
) {
  const { key } = pusherChoice(operation);
  await requireTenantDomainSource(conn, operation, key[1], history);
  await validatePusherChoiceReference(conn, operation);
  await importRegisterOperation(conn, operation);
  return await reconcilePusherChoice(conn, key[1], key[2], key[3]);
}

/** A signed inventory needs both causal closure and all selected references. */
export async function requirePusherChoices(conn: Conn, localpart: string) {
  for (const operation of await pusherChoiceOperations(conn, localpart)) {
    if (!await validatePusherChoiceReference(conn, operation)) {
      throw new LinkError(
        'LINK_UNAVAILABLE',
        'pusher selection unavailable',
        503,
      );
    }
  }
  const keys = await conn.query(
    "SELECT DISTINCT json_extract(semantic_key,'$[2]') AS app_id,json_extract(semantic_key,'$[3]') AS pushkey FROM domain_operations WHERE kind IN ('pusher','pusher-choice') AND json_extract(semantic_key,'$[1]')=?",
    [localpart],
  );
  for (const row of keys) {
    if (
      !(await selectedPusher(
        conn,
        localpart,
        String(row.app_id),
        String(row.pushkey),
      )).ready
    ) {
      throw new LinkError(
        'LINK_UNAVAILABLE',
        'pusher selection unavailable',
        503,
      );
    }
  }
}

export async function capturePusherOperations(conn: Conn, localpart: string) {
  const authority = await tenantAuthority(conn);
  if (authority?.node !== 'home') {
    throw new Error('pusher bootstrap requires home authority');
  }
  const [user] = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [localpart],
  );
  if (!user) throw new Error('pusher bootstrap account unavailable');
  if (user.deactivated === 1) return [];
  for (
    const row of await conn.query('SELECT * FROM pushers WHERE localpart=?', [
      localpart,
    ])
  ) {
    const key = JSON.stringify([
      'pusher',
      localpart,
      row.app_id,
      row.pushkey,
      row.incarnation,
    ]);
    if (!(await registerOperations(conn, key)).length) {
      await recordPusherOperation(conn, row, false);
    }
    if (
      !(await registerOperations(
        conn,
        choiceKey(localpart, String(row.app_id), String(row.pushkey)),
      )).length
    ) {
      await recordPusherChoice(conn, row);
    }
  }
  return await pusherOperations(conn, localpart);
}

/** Enrollment adopts only factless home registrations, including accounts not
 * selected for replication. Retained choices/removals always outrank native
 * recovery rows; reactivation cannot mint a replacement for either. */
export async function captureLegacyPusherOperations(conn: Conn) {
  const authority = await tenantAuthority(conn);
  if (authority?.node !== 'home') return;
  const rows = await conn.query(
    `SELECT p.* FROM pushers p
    JOIN users u ON u.localpart=p.localpart AND u.deactivated=0
    JOIN access_tokens a ON a.token=p.access_token AND a.localpart=p.localpart
    JOIN session_authority s ON s.hash=a.token AND s.localpart=p.localpart
    WHERE s.node=? AND s.incarnation=? AND s.refresh=0 AND NOT EXISTS (
      SELECT 1 FROM domain_operations o WHERE o.kind IN ('pusher','pusher-choice')
      AND json_extract(o.semantic_key,'$[1]')=p.localpart
      AND json_extract(o.semantic_key,'$[2]')=p.app_id
      AND json_extract(o.semantic_key,'$[3]')=p.pushkey)`,
    [authority.node, authority.incarnation],
  );
  for (const row of rows) {
    await recordPusherOperation(conn, row, false);
    await recordPusherChoice(conn, row);
  }
}

function pusherOperation(operation: RegisterOperation) {
  let key: unknown, value: unknown;
  try {
    key = JSON.parse(operation.semanticKey);
    value = JSON.parse(registerJson(operation.payload));
  } catch {
    throw new Error('invalid pusher operation');
  }
  if (
    !Array.isArray(key) || key.length !== 5 || key[0] !== 'pusher' ||
    !key.every((part) => typeof part === 'string') || !key[1] ||
    !/^[a-f0-9-]{36}$/.test(key[4]) ||
    JSON.stringify(key) !== operation.semanticKey || operation.kind !== 'pusher'
  ) {
    throw new Error('invalid pusher operation');
  }
  if (value !== null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('invalid pusher operation');
    }
    const body = value as Record<string, unknown>;
    const registration = body.registration as PusherRow;
    if (
      !registration || typeof registration !== 'object' ||
      Array.isArray(registration) ||
      [
        'app_id',
        'pushkey',
        'kind',
        'app_display_name',
        'device_display_name',
        'lang',
      ].some((k) =>
        typeof (registration as unknown as Record<string, unknown>)[k] !==
          'string'
      ) ||
      registration.app_id !== key[2] || registration.pushkey !== key[3] ||
      (registration.profile_tag !== null &&
        typeof registration.profile_tag !== 'string') ||
      typeof body.accessHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.accessHash) ||
      !Number.isSafeInteger(body.addedMs) || Number(body.addedMs) < 0 ||
      (body.removeOthers !== undefined && body.removeOthers !== true) ||
      Object.keys(body).sort().join(',') !==
        ('accessHash,addedMs,registration' +
          (body.removeOthers === true ? ',removeOthers' : '')) ||
      Object.keys(registration).sort().join(',') !==
        'app_display_name,app_id,data,device_display_name,kind,lang,profile_tag,pushkey'
    ) {
      throw new Error('invalid pusher operation');
    }
    validatePusher(registration);
  }
  return {
    key: key as string[],
    value: value as null | {
      registration: PusherRow;
      accessHash: string;
      addedMs: number;
      removeOthers?: true;
    },
  };
}

/** Import may cancel an exact native incarnation, never create a runnable
 * registration. Null is a monotone fence even while causal closure is pending.
 * All facts stay retained for recovery; refresh cannot undo that fence. */
export async function importPusherOperation(
  conn: Conn,
  operation: RegisterOperation,
  history?: DomainHistoryProof,
): Promise<boolean> {
  const { key, value } = pusherOperation(operation);
  const [, localpart, appId, pushkey, incarnation] = key;
  const authority = await requireTenantDomainSource(
    conn,
    operation,
    localpart,
    history,
  );
  if (value) {
    const [session] = await conn.query(
      'SELECT * FROM session_authority WHERE hash=?',
      [value.accessHash],
    );
    if (!session && !history) {
      throw new LinkError(
        'LINK_UNAVAILABLE',
        'pusher import awaits session provenance',
        503,
      );
    }
    if (
      session && (session.localpart !== localpart || session.refresh !== 0 ||
        session.node !== operation.source ||
        session.incarnation !== operation.incarnation)
    ) {
      throw new Error('pusher session provenance differs');
    }
    for (const held of await registerOperations(conn, operation.semanticKey)) {
      const previous = pusherOperation(held).value;
      if (
        previous &&
        (held.source !== operation.source ||
          held.incarnation !== operation.incarnation ||
          previous.addedMs !== value.addedMs ||
          previous.removeOthers !== value.removeOthers ||
          registerJson(JSON.stringify(previous.registration)) !==
            registerJson(JSON.stringify(value.registration)))
      ) {
        throw new Error('immutable pusher registration differs');
      }
    }
  }
  const { inserted } = await importRegisterOperation(conn, operation);
  let replaced = false;
  // The original request, not refresh/replay, executes cross-account effects
  // once at home. Its receipt and affected-account tombstones commit together.
  // Facades only receive removals on each selected account's ordinary stream.
  if (
    inserted && value?.removeOthers && operation.sequence === 1 &&
    authority.node === 'home' && operation.source !== 'home'
  ) {
    const before = conn.writes;
    await deleteOtherPusherUsers(conn, localpart, appId, pushkey);
    replaced = conn.writes !== before;
  }
  for (const choice of await pusherChoiceOperations(conn, localpart)) {
    await validatePusherChoiceReference(conn, choice);
  }
  const removed = (await registerOperations(conn, operation.semanticKey)).some((
    op,
  ) => op.payload === 'null');
  if (!removed) {
    return await reconcilePusherChoice(conn, localpart, appId, pushkey) ||
      replaced;
  }
  const rows = await conn.query(
    'SELECT * FROM pushers WHERE localpart=? AND app_id=? AND pushkey=? AND incarnation=?',
    [localpart, appId, pushkey, incarnation],
  );
  for (const row of rows) await recordPusherChange(conn, row, true);
  await conn.execute(
    'DELETE FROM pushers WHERE localpart=? AND app_id=? AND pushkey=? AND incarnation=?',
    [localpart, appId, pushkey, incarnation],
  );
  return rows.length !== 0 || replaced;
}

/** This is protected semantic source intent, not the executable sender target
 * projection below. Lifecycle removals address one immutable incarnation;
 * refresh changes its recovery digest, never its identity or original time. */
async function recordPusherOperation(
  conn: Conn,
  row: Record<string, unknown>,
  deleted: boolean,
  removeOthers?: boolean,
): Promise<void> {
  const authority = await tenantAuthority(conn);
  if (!authority) return;
  if (!deleted) {
    const [session] = await conn.query(
      'SELECT s.node,s.incarnation,s.localpart FROM session_authority s JOIN access_tokens a ON a.token=s.hash AND a.localpart=s.localpart WHERE s.hash=? AND s.refresh=0',
      [String(row.access_token)],
    );
    // A live mutation must have source authority; do not acknowledge an
    // executable registration while silently omitting its export obligation.
    if (!session || session.localpart !== row.localpart) {
      throw new MatrixError(401, 'M_UNKNOWN_TOKEN', 'Invalid pusher session');
    }
    if (
      session.node !== authority.node ||
      session.incarnation !== authority.incarnation
    ) ownerUnavailable();
  }
  const key = JSON.stringify([
    'pusher',
    row.localpart,
    row.app_id,
    row.pushkey,
    row.incarnation,
  ]);
  if (!deleted && removeOthers === undefined) {
    // Refresh retains the original request intent without executing it again.
    removeOthers = (await registerOperations(conn, key)).some((op) =>
      pusherOperation(op).value?.removeOthers === true
    );
  }
  await writeRegister(
    conn,
    { source: authority.node, incarnation: authority.incarnation },
    key,
    'pusher',
    JSON.stringify(
      deleted ? null : {
        registration: {
          app_id: row.app_id,
          pushkey: row.pushkey,
          kind: row.kind,
          app_display_name: row.app_display_name,
          device_display_name: row.device_display_name,
          profile_tag: row.profile_tag ?? null,
          lang: row.lang,
          data: JSON.parse(String(row.data)),
        },
        accessHash: row.access_token,
        addedMs: row.added_ms,
        ...(removeOthers ? { removeOthers: true } : {}),
      },
    ),
  );
}

export async function recordPusherChange(
  conn: Conn,
  row: Record<string, unknown>,
  deleted: boolean,
): Promise<void> {
  // Projection replay (including historical schema upgrades) must not acquire
  // registration authorship or depend on later authority/domain schemas.
  await conn.execute(
    'INSERT INTO pusher_changes(pos,localpart,app_id,pushkey,incarnation,payload) VALUES(?,?,?,?,?,?)',
    [
      await nextCounter(conn, 'pusher_changes'),
      String(row.localpart),
      String(row.app_id),
      String(row.pushkey),
      String(row.incarnation),
      deleted ? null : JSON.stringify({
        kind: row.kind,
        data: JSON.parse(String(row.data)),
        profile_tag: row.profile_tag,
        added_ms: row.added_ms,
      }),
    ],
  );
}

type PusherMatch = {
  localpart?: string;
  notLocalpart?: string;
  appId?: string;
  pushkey?: string;
  incarnation?: string;
  accessHash?: string;
};

function pusherWhere(match: PusherMatch, semantic = false) {
  const columns = semantic
    ? {
      localpart: "json_extract(semantic_key,'$[1]')",
      notLocalpart: "json_extract(semantic_key,'$[1]')",
      appId: "json_extract(semantic_key,'$[2]')",
      pushkey: "json_extract(semantic_key,'$[3]')",
      incarnation: "json_extract(semantic_key,'$[4]')",
      accessHash: null,
    }
    : {
      localpart: 'localpart',
      notLocalpart: 'localpart',
      appId: 'app_id',
      pushkey: 'pushkey',
      incarnation: 'incarnation',
      accessHash: 'access_token',
    };
  const terms: string[] = semantic ? ["kind='pusher'"] : [];
  const args: string[] = [];
  for (const name of Object.keys(columns) as (keyof PusherMatch)[]) {
    if (match[name] === undefined || columns[name] === null) continue;
    terms.push(columns[name] + (name === 'notLocalpart' ? '<>?' : '=?'));
    args.push(match[name]!);
  }
  return { where: terms.join(' AND '), args };
}

/** Registrations have one removal owner whether locally executable or retained
 * only as foreign recovery facts. Observe pending puts too: an exact-incarnation
 * null is a fence even without that put's complete causal ancestry. */
async function retirePusherOperations(conn: Conn, match: PusherMatch) {
  const { where, args } = pusherWhere(match, true);
  const keys = await conn.query(
    'SELECT DISTINCT semantic_key FROM domain_operations WHERE ' + where,
    args,
  );
  for (const row of keys) {
    const key = String(row.semantic_key);
    const operations = await registerOperations(conn, key);
    if (operations.some((op) => op.payload === 'null')) continue;
    if (match.accessHash !== undefined) {
      // A revoked predecessor digest must not remove an incarnation already
      // moved by refresh. Historical digests are not current token ownership.
      const view = await readRegister(conn, key);
      if (
        !view.winner ||
        pusherOperation(view.winner).value?.accessHash !== match.accessHash
      ) continue;
    }
    const [, localpart, app_id, pushkey, incarnation] =
      pusherOperation(operations[0]).key;
    await recordPusherOperation(conn, {
      localpart,
      app_id,
      pushkey,
      incarnation,
    }, true);
  }
}

async function deleteMatching(
  conn: Conn,
  match: PusherMatch,
  record = true,
): Promise<void> {
  // Imported authority projects cancellation, not another local source fact.
  const { where, args } = pusherWhere(match);
  const rows = await conn.query('SELECT * FROM pushers WHERE ' + where, args);
  for (const row of rows) {
    if (record) await recordPusherOperation(conn, row, true);
    await recordPusherChange(conn, row, true);
  }
  if (record) await retirePusherOperations(conn, match);
  await conn.execute('DELETE FROM pushers WHERE ' + where, args);
}

/** Refresh retains pushers while replacing the token that owns them. */
export async function movePusherToken(
  conn: Conn,
  oldHash: string,
  newHash: string,
): Promise<void> {
  const rows = await conn.query('SELECT * FROM pushers WHERE access_token=?', [
    oldHash,
  ]);
  await conn.execute(
    'UPDATE pushers SET access_token = ? WHERE access_token = ?',
    [newHash, oldHash],
  );
  for (const row of rows) {
    await recordPusherOperation(conn, { ...row, access_token: newHash }, false);
  }
}

export async function deletePushersForToken(
  conn: Conn,
  accessHash: string,
  record = true,
): Promise<void> {
  await deleteMatching(conn, { accessHash }, record);
}

export async function deletePushersOfUser(
  conn: Conn,
  localpart: string,
  record = true,
): Promise<void> {
  await deleteMatching(conn, { localpart }, record);
}

export type PusherRow = {
  app_id: string;
  pushkey: string;
  kind: string;
  app_display_name: string;
  device_display_name: string;
  profile_tag: string | null;
  lang: string;
  data: unknown;
};

export type PusherInput = {
  app_id: string;
  pushkey: string;
  kind: string | null;
  app_display_name: string;
  device_display_name: string;
  profile_tag?: string | null;
  lang: string;
  data: unknown;
  append?: boolean;
};

// --- conn-level rows (bound on TenantTx) -----------------------------------

export async function deletePusherRow(
  conn: Conn,
  localpart: string,
  appId: string,
  pushkey: string,
): Promise<void> {
  await deleteMatching(conn, { localpart, appId, pushkey });
  // Preserve explicit group removal even if its registration was not held at
  // this ingress. A later observed put may supersede this causal null normally.
  await recordPusherChoice(conn, { localpart, app_id: appId, pushkey }, true);
}

/** Rejection of an old in-flight request cannot remove a new registration. */
export async function deleteRejectedPusher(
  conn: Conn,
  localpart: string,
  appId: string,
  pushkey: string,
  incarnation: string,
): Promise<void> {
  await deleteMatching(conn, { localpart, appId, pushkey, incarnation });
}

export async function upsertPusherRow(
  conn: Conn,
  localpart: string,
  pusher: PusherInput & { kind: string },
  accessHash: string,
): Promise<void> {
  await requireSessionAuthority(conn, accessHash, false);
  // Replacing a row must retain the exact old incarnation's removal before
  // overwriting it. The local sender projection still needs only the new row.
  for (
    const row of await conn.query(
      'SELECT * FROM pushers WHERE localpart=? AND app_id=? AND pushkey=?',
      [localpart, pusher.app_id, pusher.pushkey],
    )
  ) await recordPusherOperation(conn, row, true);
  await retirePusherOperations(conn, {
    localpart,
    appId: pusher.app_id,
    pushkey: pusher.pushkey,
  });
  const incarnation = crypto.randomUUID();
  const added = Date.now();
  await conn.execute(
    `INSERT INTO pushers (localpart, app_id, pushkey, kind, app_display_name, device_display_name, profile_tag, lang, data, access_token, incarnation, added_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (localpart, app_id, pushkey) DO UPDATE SET
       kind = excluded.kind, app_display_name = excluded.app_display_name,
       device_display_name = excluded.device_display_name,
       profile_tag = excluded.profile_tag, lang = excluded.lang,
        data = excluded.data, access_token = excluded.access_token,
        incarnation = excluded.incarnation, added_ms = excluded.added_ms`,
    [
      localpart,
      pusher.app_id,
      pusher.pushkey,
      pusher.kind,
      pusher.app_display_name,
      pusher.device_display_name,
      pusher.profile_tag ?? null,
      pusher.lang,
      JSON.stringify(pusher.data),
      accessHash,
      incarnation,
      added,
    ],
  );
  const row = {
    localpart,
    ...pusher,
    incarnation,
    added_ms: added,
    access_token: accessHash,
    data: JSON.stringify(pusher.data),
  };
  await recordPusherOperation(conn, row, false, !pusher.append);
  await recordPusherChoice(conn, row);
  await recordPusherChange(conn, row, false);
}

export async function pushersOfUser(
  conn: Conn,
  localpart: string,
): Promise<PusherRow[]> {
  if (await tenantAuthority(conn)) {
    const keys = await conn.query(
      "SELECT DISTINCT json_extract(semantic_key,'$[2]') AS app_id,json_extract(semantic_key,'$[3]') AS pushkey FROM domain_operations WHERE kind IN ('pusher','pusher-choice') AND json_extract(semantic_key,'$[1]')=? ORDER BY app_id,pushkey",
      [localpart],
    );
    const result: PusherRow[] = [];
    for (const row of keys) {
      const selected = await selectedPusher(
        conn,
        localpart,
        String(row.app_id),
        String(row.pushkey),
      );
      if (!selected.ready) {
        throw new MatrixError(
          503,
          'M_UNAVAILABLE',
          'pusher selection unavailable',
        );
      }
      if (selected.value) result.push(selected.value.registration);
    }
    return result;
  }
  const rows = await conn.query(
    'SELECT app_id, pushkey, kind, app_display_name, device_display_name, profile_tag, lang, data FROM pushers WHERE localpart = ?',
    [localpart],
  );
  return rows.map((row) => ({
    app_id: String(row.app_id),
    pushkey: String(row.pushkey),
    kind: String(row.kind),
    app_display_name: String(row.app_display_name),
    device_display_name: String(row.device_display_name),
    profile_tag: row.profile_tag == null ? null : String(row.profile_tag),
    lang: String(row.lang),
    data: JSON.parse(String(row.data)),
  }));
}

export async function pusherIncarnations(
  conn: Conn,
  localpart: string,
): Promise<string[]> {
  return (await capturePusherIncarnations(conn, [localpart])).get(localpart) ??
    [];
}

/** Capture durable routing candidates, not permission to send. An incomplete
 * choice retains work for final admission instead of blocking publication or
 * discarding a notification. A resolved losing choice never gains a route. */
export async function capturePusherIncarnations(
  conn: Conn,
  localparts: readonly string[],
): Promise<Map<string, string[]>> {
  const selected = [...new Set(localparts)];
  const result = new Map<string, string[]>(selected.map((lp) => [lp, []]));
  if (!selected.length) return result;
  const rows = await nativePusherCandidates(conn, selected);
  if (!rows.length) return result;
  const enrolled = await tenantAuthority(conn);
  let reader: SelectionReader | undefined;
  let sessions:
    | Awaited<ReturnType<typeof captureRetainedSessionAuthorities>>
    | undefined;
  if (enrolled) {
    const operations = (await conn.query(
      "SELECT * FROM domain_operations WHERE kind IN ('pusher','pusher-choice') AND json_extract(semantic_key,'$[1]') IN (SELECT CAST(value AS TEXT) FROM json_each(?))",
      [JSON.stringify(selected)],
    )).map(registerOperationFromRow);
    const groups = new Map<string, RegisterOperation[]>();
    const keys = new Map<string, Set<string>>();
    const hashes = new Set(rows.map((row) => String(row.access_token)));
    for (const op of operations) {
      const group = groups.get(op.semanticKey) ?? [];
      group.push(op);
      groups.set(op.semanticKey, group);
      if (op.kind === 'pusher') {
        const { key, value } = pusherOperation(op);
        const identity = JSON.stringify(key.slice(1, 4));
        const set = keys.get(identity) ?? new Set<string>();
        set.add(op.semanticKey);
        keys.set(identity, set);
        if (value) hashes.add(value.accessHash);
      }
    }
    sessions = await captureRetainedSessionAuthorities(conn, [...hashes]);
    const heldSessions = sessions;
    reader = {
      // Every selection below is for an already joined live native candidate.
      deactivated: () => false,
      native: () => true,
      register: (key) => registerView(groups.get(key) ?? []),
      operations: (key) => groups.get(key) ?? [],
      keys: (
        lp,
        appId,
        pushkey,
      ) => [...keys.get(JSON.stringify([lp, appId, pushkey])) ?? []],
      session: (hash) => heldSessions(hash, false),
    };
  }
  for (const row of rows) {
    if (enrolled) {
      if (
        !await pusherSessionIsCurrent(
          conn,
          String(row.access_token),
          () =>
            assertSessionAuthorityOwner(
              enrolled,
              sessions!(String(row.access_token), false),
            ),
        )
      ) {
        continue;
      }
      const choice = await selectedPusher(
        conn,
        String(row.localpart),
        String(row.app_id),
        String(row.pushkey),
        reader,
      );
      if (choice.ready && choice.incarnation !== row.incarnation) continue;
    }
    result.get(String(row.localpart))!.push(String(row.incarnation));
  }
  return result;
}

/** The native token/device predicate is shared by send and publication admission. */
function nativePusherCandidates(
  conn: Conn,
  localparts: readonly string[],
  target?: { appId: string; pushkey: string; incarnation: string },
) {
  return conn.query(
    `SELECT p.localpart,p.app_id,p.pushkey,p.incarnation,p.access_token
    FROM json_each(?) selected JOIN pushers p ON p.localpart=CAST(selected.value AS TEXT)
    JOIN users u ON u.localpart=p.localpart
    JOIN access_tokens a ON a.token=p.access_token AND a.localpart=p.localpart
    WHERE p.kind='http' AND u.deactivated=0 AND (a.device_id IS NULL OR EXISTS (
      SELECT 1 FROM devices d WHERE d.localpart=a.localpart AND d.device_id=a.device_id AND d.generation=a.generation))` +
      (target ? ' AND p.app_id=? AND p.pushkey=? AND p.incarnation=?' : '') +
      ' ORDER BY p.localpart,p.app_id,p.pushkey',
    [
      JSON.stringify(localparts),
      ...(target ? [target.appId, target.pushkey, target.incarnation] : []),
    ],
  );
}

async function pusherSessionIsCurrent(
  conn: Conn,
  accessHash: string,
  captured?: () => void,
) {
  try {
    if (captured) captured();
    else await requireSessionAuthority(conn, accessHash, false);
    return true;
  } catch (error) {
    if (!(error instanceof MatrixError) || ![401, 503].includes(error.status)) {
      throw error;
    }
    return false;
  }
}

/** Send admission reads account, registration and its current token/device
 * generation in one tenant snapshot. Refresh moves ownership without changing
 * the incarnation; deletion/recreation cannot revive an old registration. */
export async function pusherIsCurrent(
  conn: Conn,
  localpart: string,
  appId: string,
  pushkey: string,
  incarnation: string,
): Promise<boolean> {
  const [native] = await nativePusherCandidates(conn, [localpart], {
    appId,
    pushkey,
    incarnation,
  });
  if (!native) return false;
  if (await tenantAuthority(conn)) {
    if (!await pusherSessionIsCurrent(conn, String(native.access_token))) {
      return false;
    }
    const selected = await selectedPusher(conn, localpart, appId, pushkey);
    if (!selected.ready) {
      throw new MatrixError(
        503,
        'M_UNAVAILABLE',
        'pusher selection unavailable',
      );
    }
    if (selected.incarnation !== incarnation) return false;
  }
  return true;
}

// --- tenant-level behaviour --------------------------------------------------

/** kind null → delete that (app_id, pushkey); else upsert bound to the
 * caller's token (its hash is what's stored). */
export async function setPusher(
  tenant: Tenant,
  localpart: string,
  token: string,
  pusher: PusherInput,
): Promise<void> {
  validatePusher(pusher);
  const hash = await hashToken(token);
  await tenant.tx(async (tx) => {
    await tx.ingress.check({ kind: 'session', hash, refresh: false });
    const access = await tx.tokens.byHash(hash);
    if (
      !access || access.localpart !== localpart ||
      (await tx.users.byLocalpart(localpart))?.deactivated
    ) {
      throw new MatrixError(
        401,
        'M_UNKNOWN_TOKEN',
        'Pusher token is no longer valid',
      );
    }
    if (pusher.kind === null) {
      await tx.pushers.delete(localpart, pusher.app_id, pusher.pushkey);
      return;
    }
    if (!pusher.append) {
      await tx.pushers.deleteOtherUsers(
        localpart,
        pusher.app_id,
        pusher.pushkey,
      );
    }
    await tx.pushers.upsert(
      localpart,
      { ...pusher, kind: pusher.kind },
      hash,
    );
  });
}

export async function deleteOtherPusherUsers(
  conn: Conn,
  localpart: string,
  appId: string,
  pushkey: string,
): Promise<void> {
  await deleteMatching(conn, { notLocalpart: localpart, appId, pushkey });
}

/** The caller's pushers — never returns access_token. */
export async function listPushers(
  tenant: Tenant,
  localpart: string,
): Promise<PusherRow[]> {
  return await tenant.tx(async (tx) => {
    await tx.ingress.check({
      kind: 'domain-read',
      localpart,
      feature: 'pushers',
    });
    return await tx.pushers.ofUser(localpart);
  });
}
