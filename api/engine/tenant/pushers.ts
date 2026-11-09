// Tenant-authoritative pusher registrations and incarnationed lifecycle log.
// Every deletion uses this owner, including device/token/account revocation.
import type { Conn } from '#engine/store/db.ts';
import { hashToken } from '#engine/tenant/auth.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { validatePusher } from '#engine/push/registration.ts';

export async function recordPusherChange(
  conn: Conn,
  row: Record<string, unknown>,
  deleted: boolean,
): Promise<void> {
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
  for (const row of rows) await recordPusherChange(conn, row, true);
  await conn.execute('DELETE FROM pushers WHERE ' + where, args);
}

/** Refresh retains pushers while replacing the token that owns them. */
export async function movePusherToken(
  conn: Conn,
  oldHash: string,
  newHash: string,
): Promise<void> {
  await conn.execute(
    'UPDATE pushers SET access_token = ? WHERE access_token = ?',
    [newHash, oldHash],
  );
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
  await recordPusherChange(conn, {
    localpart,
    ...pusher,
    incarnation,
    added_ms: added,
    data: JSON.stringify(pusher.data),
  }, false);
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
