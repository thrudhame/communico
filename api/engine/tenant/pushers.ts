// api/engine/tenant/pushers.ts — pusher rows (M2; storage only, no
// gateway traffic until Push proper). The delete cascades landed with the
// token stage (revocation needs them); setPusher/listPushers are the
// pusher API. access_token is the hash of the token that made the pusher.
import type { Conn } from '#engine/store/db.ts';
import { hashToken } from '#engine/tenant/auth.ts';
import type { Tenant } from '#engine/tenant/index.ts';

export async function deletePushersForToken(
  conn: Conn,
  accessHash: string,
): Promise<void> {
  await conn.execute('DELETE FROM pushers WHERE access_token = ?', [
    accessHash,
  ]);
}

export async function deletePushersOfUser(
  conn: Conn,
  localpart: string,
): Promise<void> {
  await conn.execute('DELETE FROM pushers WHERE localpart = ?', [localpart]);
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
};

// --- conn-level rows (bound on TenantTx) -----------------------------------

export async function deletePusherRow(
  conn: Conn,
  localpart: string,
  appId: string,
  pushkey: string,
): Promise<void> {
  await conn.execute(
    'DELETE FROM pushers WHERE localpart = ? AND app_id = ? AND pushkey = ?',
    [localpart, appId, pushkey],
  );
}

export async function upsertPusherRow(
  conn: Conn,
  localpart: string,
  pusher: PusherInput & { kind: string },
  accessHash: string,
): Promise<void> {
  await conn.execute(
    `INSERT INTO pushers (localpart, app_id, pushkey, kind, app_display_name, device_display_name, profile_tag, lang, data, access_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (localpart, app_id, pushkey) DO UPDATE SET
       kind = excluded.kind, app_display_name = excluded.app_display_name,
       device_display_name = excluded.device_display_name,
       profile_tag = excluded.profile_tag, lang = excluded.lang,
       data = excluded.data, access_token = excluded.access_token`,
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
    ],
  );
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
  await tenant.tx(async (tx) => {
    if (pusher.kind === null) {
      await tx.pushers.delete(localpart, pusher.app_id, pusher.pushkey);
      return;
    }
    await tx.pushers.upsert(
      localpart,
      { ...pusher, kind: pusher.kind },
      await hashToken(token),
    );
  });
}

/** The caller's pushers — never returns access_token. */
export async function listPushers(
  tenant: Tenant,
  localpart: string,
): Promise<PusherRow[]> {
  return await tenant.tx((tx) => tx.pushers.ofUser(localpart));
}
