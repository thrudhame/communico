// Home-owned verifier/status snapshots. These are protected semantic records,
// never a tenant clone or permission to validate another issuer's sessions.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Conn } from '#engine/store/db.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import {
  clearCredential,
  credentialHash,
  credentialRevision,
  deactivateUserRows,
  insertUser,
  setCredential,
  userByLocalpart,
} from '#engine/tenant/users.ts';
import {
  type AuthorityFact,
  captureSessionAuthority,
  installSessionAuthority,
  type SessionFact,
} from '#engine/tenant/session-authority.ts';
import type { ErasureCut } from '#engine/room/state.ts';

export const ACCOUNT_AUTH_SQL = `
CREATE TABLE account_auth_sources(localpart TEXT PRIMARY KEY NOT NULL,revision INTEGER NOT NULL,material_hash TEXT NOT NULL,captured_ms INTEGER NOT NULL);
CREATE TABLE account_auth_snapshots(localpart TEXT PRIMARY KEY NOT NULL,pairing TEXT NOT NULL,grant_revision INTEGER NOT NULL,owner_revision INTEGER NOT NULL,source_cut INTEGER NOT NULL,revision INTEGER NOT NULL,material_hash TEXT NOT NULL,captured_ms INTEGER NOT NULL,checked_ms INTEGER NOT NULL,credentials INTEGER NOT NULL);
`;

export type AccountAuth = {
  kind: 'account-auth';
  server: string;
  pairing: string;
  grantRevision: number;
  ownerRevision: number;
  localpart: string;
  sourceCut: number;
  revision: number;
  capturedMs: number;
  credentials: boolean;
  phc: string | null;
  deactivated: boolean;
  authority: { facts: AuthorityFact[]; sessions: SessionFact[] };
};

function material(
  view: Pick<AccountAuth, 'credentials' | 'phc' | 'deactivated' | 'authority'>,
) {
  return createHash('sha256').update(canonicalJson({
    credentials: view.credentials,
    phc: view.phc,
    deactivated: view.deactivated,
    authority: view.authority,
  })).digest('hex');
}

export function authUnavailable(): never {
  throw new MatrixError(
    503,
    'M_UNAVAILABLE',
    'authentication snapshot unavailable',
  );
}

export async function captureAccountAuth(
  conn: Conn,
  binding: Pick<
    AccountAuth,
    'server' | 'pairing' | 'grantRevision' | 'ownerRevision'
  >,
  localpart: string,
  credentials: boolean,
  now: number,
): Promise<AccountAuth> {
  const user = await userByLocalpart(conn, localpart);
  if (!user) authUnavailable();
  const phc = credentials && !user.deactivated
    ? await credentialHash(conn, localpart)
    : null;
  const view = {
    credentials,
    phc,
    deactivated: user.deactivated,
    authority: await captureSessionAuthority(conn, localpart),
  };
  const hash = createHash('sha256').update(canonicalJson({
    material: material(view),
    credentialRevision: await credentialRevision(conn, localpart),
  })).digest('hex');
  const [old] = await conn.query(
    'SELECT revision,material_hash,captured_ms FROM account_auth_sources WHERE localpart=?',
    [localpart],
  );
  // A regressed home clock cannot mint a newer freshness declaration.
  if (old && now < Number(old.captured_ms)) authUnavailable();
  const revision = old
    ? Number(old.revision) + (old.material_hash === hash ? 0 : 1)
    : 1;
  await conn.execute(
    'INSERT INTO account_auth_sources(localpart,revision,material_hash,captured_ms) VALUES(?,?,?,?) ON CONFLICT(localpart) DO UPDATE SET revision=excluded.revision,material_hash=excluded.material_hash,captured_ms=excluded.captured_ms',
    [localpart, revision, hash, now],
  );
  return {
    kind: 'account-auth',
    ...binding,
    localpart,
    revision,
    capturedMs: now,
    sourceCut: await nextCounter(conn, 'account_auth_source'),
    ...view,
  };
}

export async function installAccountAuth(
  conn: Conn,
  view: AccountAuth,
  erasureCuts?: Record<string, ErasureCut>,
): Promise<void> {
  const [old] = await conn.query(
    'SELECT * FROM account_auth_snapshots WHERE localpart=?',
    [view.localpart],
  );
  const hash = material(view);
  if (old?.pairing === view.pairing) {
    if (
      view.sourceCut < Number(old.source_cut) ||
      view.revision < Number(old.revision) ||
      view.capturedMs < Number(old.captured_ms)
    ) authUnavailable();
    if (view.revision === Number(old.revision) && old.material_hash !== hash) {
      authUnavailable();
    }
    if (view.sourceCut === Number(old.source_cut)) {
      if (
        Number(old.revision) !== view.revision || old.material_hash !== hash ||
        Number(old.captured_ms) !== view.capturedMs ||
        Number(old.grant_revision) !== view.grantRevision ||
        Number(old.owner_revision) !== view.ownerRevision
      ) authUnavailable();
      return;
    }
  }
  let user = await userByLocalpart(conn, view.localpart);
  if (!user) {
    await insertUser(conn, view.localpart, view.localpart);
    user = await userByLocalpart(conn, view.localpart);
  }
  await installSessionAuthority(
    conn,
    view.localpart,
    view.authority,
    erasureCuts,
  );
  user = await userByLocalpart(conn, view.localpart);
  if (view.deactivated) {
    await deactivateUserRows(
      conn,
      view.server,
      view.localpart,
      undefined,
      true,
    );
  }
  if (
    view.deactivated || user?.deactivated || !view.credentials ||
    view.phc === null
  ) {
    await clearCredential(conn, view.localpart);
  } else {
    await setCredential(conn, view.localpart, view.phc);
  }
  await conn.execute(
    'INSERT INTO account_auth_snapshots(localpart,pairing,grant_revision,owner_revision,source_cut,revision,material_hash,captured_ms,checked_ms,credentials) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(localpart) DO UPDATE SET pairing=excluded.pairing,grant_revision=excluded.grant_revision,owner_revision=excluded.owner_revision,source_cut=excluded.source_cut,revision=excluded.revision,material_hash=excluded.material_hash,captured_ms=excluded.captured_ms,checked_ms=excluded.checked_ms,credentials=excluded.credentials',
    [
      view.localpart,
      view.pairing,
      view.grantRevision,
      view.ownerRevision,
      view.sourceCut,
      view.revision,
      hash,
      view.capturedMs,
      Math.max(Number(old?.checked_ms ?? 0), view.capturedMs),
      view.credentials ? 1 : 0,
    ],
  );
}

export type AuthSnapshotBinding = {
  pairing: string;
  grantRevision: number;
  ownerRevision: number;
  sourceCut?: number;
};

export async function requireAccountAuth(
  conn: Conn,
  localpart: string,
  binding: AuthSnapshotBinding,
  settings: { allowstaleauth: boolean; authmaxstalehours: number },
  reconciled: boolean,
  credentials: boolean,
  now = Date.now(),
): Promise<void> {
  const [row] = await conn.query(
    'SELECT * FROM account_auth_snapshots WHERE localpart=?',
    [localpart],
  );
  if (
    !row || row.pairing !== binding.pairing ||
    Number(row.grant_revision) !== binding.grantRevision ||
    Number(row.owner_revision) !== binding.ownerRevision ||
    (binding.sourceCut !== undefined &&
      Number(row.source_cut) !== binding.sourceCut) ||
    (credentials && row.credentials !== 1)
  ) authUnavailable();
  if (
    (!settings.allowstaleauth && !reconciled) || now < Number(row.checked_ms) ||
    now < Number(row.captured_ms) ||
    (settings.authmaxstalehours > 0 &&
      now - Number(row.captured_ms) > settings.authmaxstalehours * 3600000)
  ) authUnavailable();
  if (now > Number(row.checked_ms)) {
    await conn.execute(
      'UPDATE account_auth_snapshots SET checked_ms=? WHERE localpart=?',
      [now, localpart],
    );
  }
}
