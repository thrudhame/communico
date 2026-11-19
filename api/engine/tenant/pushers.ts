// Tenant-authoritative pusher registrations and incarnationed lifecycle log.
// Every deletion uses this owner, including device/token/account revocation.
import type { Conn } from '#engine/store/db.ts';
import { hashToken } from '#engine/tenant/auth.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { validatePusher } from '#engine/push/registration.ts';
import {
  ownerUnavailable,
  requireSessionAuthority,
  tenantAuthority,
} from '#engine/tenant/session-authority.ts';
import {
  importRegisterOperation,
  registerJson,
  type RegisterOperation,
  registerOperations,
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
  }
  return await pusherOperations(conn, localpart);
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
      Object.keys(body).sort().join(',') !==
        'accessHash,addedMs,registration' ||
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
  await requireTenantDomainSource(conn, operation, localpart, history);
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
          registerJson(JSON.stringify(previous.registration)) !==
            registerJson(JSON.stringify(value.registration)))
      ) {
        throw new Error('immutable pusher registration differs');
      }
    }
  }
  await importRegisterOperation(conn, operation);
  const removed = (await registerOperations(conn, operation.semanticKey)).some((
    op,
  ) => op.payload === 'null');
  if (!removed) return false;
  const rows = await conn.query(
    'SELECT * FROM pushers WHERE localpart=? AND app_id=? AND pushkey=? AND incarnation=?',
    [localpart, appId, pushkey, incarnation],
  );
  for (const row of rows) await recordPusherChange(conn, row, true);
  await conn.execute(
    'DELETE FROM pushers WHERE localpart=? AND app_id=? AND pushkey=? AND incarnation=?',
    [localpart, appId, pushkey, incarnation],
  );
  return rows.length !== 0;
}

/** This is protected semantic source intent, not the executable sender target
 * projection below. Lifecycle removals address one immutable incarnation;
 * refresh changes its recovery digest, never its identity or original time. */
async function recordPusherOperation(
  conn: Conn,
  row: Record<string, unknown>,
  deleted: boolean,
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
  await writeRegister(
    conn,
    { source: authority.node, incarnation: authority.incarnation },
    JSON.stringify([
      'pusher',
      row.localpart,
      row.app_id,
      row.pushkey,
      row.incarnation,
    ]),
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

async function deleteMatching(
  conn: Conn,
  where: string,
  args: (string | number)[],
): Promise<void> {
  const rows = await conn.query('SELECT * FROM pushers WHERE ' + where, args);
  for (const row of rows) {
    await recordPusherOperation(conn, row, true);
    await recordPusherChange(conn, row, true);
  }
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
): Promise<void> {
  await deleteMatching(conn, 'access_token = ?', [accessHash]);
}

export async function deletePushersOfUser(
  conn: Conn,
  localpart: string,
): Promise<void> {
  await deleteMatching(conn, 'localpart = ?', [localpart]);
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
  await deleteMatching(conn, 'localpart = ? AND app_id = ? AND pushkey = ?', [
    localpart,
    appId,
    pushkey,
  ]);
}

/** Rejection of an old in-flight request cannot remove a new registration. */
export async function deleteRejectedPusher(
  conn: Conn,
  localpart: string,
  appId: string,
  pushkey: string,
  incarnation: string,
): Promise<void> {
  await deleteMatching(
    conn,
    'localpart=? AND app_id=? AND pushkey=? AND incarnation=?',
    [localpart, appId, pushkey, incarnation],
  );
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
  await recordPusherOperation(conn, row, false);
  await recordPusherChange(conn, row, false);
}

export async function pushersOfUser(
  conn: Conn,
  localpart: string,
): Promise<PusherRow[]> {
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
  return (await conn.query(
    "SELECT incarnation FROM pushers WHERE localpart=? AND kind='http'",
    [localpart],
  )).map((row) => String(row.incarnation));
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
  return (await conn.query(
    `SELECT 1 FROM pushers p JOIN users u ON u.localpart=p.localpart
    JOIN access_tokens a ON a.token=p.access_token AND a.localpart=p.localpart
    WHERE p.localpart=? AND p.app_id=? AND p.pushkey=? AND p.incarnation=?
    AND p.kind='http' AND u.deactivated=0 AND (a.device_id IS NULL OR EXISTS (
      SELECT 1 FROM devices d WHERE d.localpart=a.localpart AND d.device_id=a.device_id AND d.generation=a.generation))`,
    [localpart, appId, pushkey, incarnation],
  )).length !== 0;
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
  await deleteMatching(conn, 'localpart<>? AND app_id=? AND pushkey=?', [
    localpart,
    appId,
    pushkey,
  ]);
}

/** The caller's pushers — never returns access_token. */
export async function listPushers(
  tenant: Tenant,
  localpart: string,
): Promise<PusherRow[]> {
  return await tenant.tx((tx) => tx.pushers.ofUser(localpart));
}
