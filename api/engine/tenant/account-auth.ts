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

export const ACCOUNT_AUTH_PUBLICATION_SQL = `
CREATE TABLE account_auth_publications(localpart TEXT PRIMARY KEY NOT NULL,pairing TEXT NOT NULL,grant_revision INTEGER NOT NULL,owner_revision INTEGER NOT NULL,source_cut INTEGER NOT NULL,sequence INTEGER NOT NULL,hash TEXT NOT NULL);
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
  let installed = false;
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
    installed = view.revision === Number(old.revision) &&
      Number(old.grant_revision) === view.grantRevision &&
      Number(old.owner_revision) === view.ownerRevision;
  }
  // Freshness is a new source declaration, not a new semantic authority cut.
  // Its material/binding has already been authenticated and installed. Replaying
  // retained sessions here makes periodic freshness compete with revocations.
  if (!installed) {
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

/** A complete authority snapshot can replace only its own authenticated prefix.
 * Omitted tombstones or sessions are not proof of supersession. */
export function accountAuthSupersedes(
  prior: AccountAuth,
  next: AccountAuth,
): boolean {
  if (
    prior.server !== next.server || prior.localpart !== next.localpart ||
    prior.pairing !== next.pairing ||
    prior.grantRevision !== next.grantRevision ||
    prior.ownerRevision !== next.ownerRevision ||
    next.sourceCut <= prior.sourceCut ||
    next.revision < prior.revision || next.capturedMs < prior.capturedMs ||
    (prior.deactivated && !next.deactivated) ||
    (next.revision === prior.revision && material(prior) !== material(next))
  ) return false;
  const facts = new Map(
    next.authority.facts.map((fact) => [fact.id, canonicalJson(fact)]),
  );
  if (
    prior.authority.facts.some((fact) =>
      facts.get(fact.id) !== canonicalJson(fact)
    )
  ) return false;
  const sessions = new Map(
    next.authority.sessions.map((session) => [session.hash, session]),
  );
  return prior.authority.sessions.every((session) => {
    const held = sessions.get(session.hash);
    if (!held || held.revision < session.revision) return false;
    if (held.revision === session.revision) {
      return canonicalJson(held) === canonicalJson(session);
    }
    if (
      !session.refresh || (session.nextHash !== null && held.nextHash === null)
    ) return false;
    const {
      revision: _oldRevision,
      accessHash: _oldAccess,
      nextHash: _oldNext,
      ...oldIdentity
    } = session;
    const {
      revision: _newRevision,
      accessHash: _newAccess,
      nextHash: _newNext,
      ...newIdentity
    } = held;
    return canonicalJson(oldIdentity) === canonicalJson(newIdentity);
  });
}

export type AuthSnapshotBinding = {
  pairing: string;
  grantRevision: number;
  ownerRevision: number;
  sourceCut?: number;
};

/** The verified receiver publishes admission with the installed owner state.
 * The server journal ACK is a recoverable projection, not a second commit point
 * that can be paired with a newer tenant snapshot by a concurrent request. */
export async function publishAccountAuth(
  conn: Conn,
  view: AccountAuth,
  cut: { sequence: number; hash: string },
  erasureCuts?: Record<string, ErasureCut>,
): Promise<void> {
  const [held] = await conn.query(
    'SELECT pairing,source_cut,sequence,hash FROM account_auth_publications WHERE localpart=?',
    [view.localpart],
  );
  if (
    held?.pairing === view.pairing &&
    Number(held.source_cut) === view.sourceCut &&
    (Number(held.sequence) !== cut.sequence || held.hash !== cut.hash)
  ) authUnavailable();
  await installAccountAuth(conn, view, erasureCuts);
  await conn.execute(
    'INSERT INTO account_auth_publications(localpart,pairing,grant_revision,owner_revision,source_cut,sequence,hash) VALUES(?,?,?,?,?,?,?) ON CONFLICT(localpart) DO UPDATE SET pairing=excluded.pairing,grant_revision=excluded.grant_revision,owner_revision=excluded.owner_revision,source_cut=excluded.source_cut,sequence=excluded.sequence,hash=excluded.hash',
    [
      view.localpart,
      view.pairing,
      view.grantRevision,
      view.ownerRevision,
      view.sourceCut,
      cut.sequence,
      cut.hash,
    ],
  );
}

/** Read both halves at the caller's tenant transaction cut. Bare installation
 * or a fabricated newer source counter never grants published admission. */
export async function accountAuthPublication(
  conn: Conn,
  localpart: string,
  binding: Omit<AuthSnapshotBinding, 'sourceCut'>,
) {
  const [row] = await conn.query(
    'SELECT p.source_cut,p.sequence,p.hash FROM account_auth_publications p JOIN account_auth_snapshots s ON s.localpart=p.localpart AND s.pairing=p.pairing AND s.grant_revision=p.grant_revision AND s.owner_revision=p.owner_revision AND s.source_cut=p.source_cut WHERE p.localpart=? AND p.pairing=? AND p.grant_revision=? AND p.owner_revision=?',
    [localpart, binding.pairing, binding.grantRevision, binding.ownerRevision],
  );
  if (!row) authUnavailable();
  return {
    sourceCut: Number(row.source_cut),
    sequence: Number(row.sequence),
    hash: String(row.hash),
  };
}

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
  // Imported authority and this ingress's clock observation are independent
  // owners. Writing checked_ms on the snapshot makes every authenticated read
  // compete with its importer, so sustained clients can starve revocations.
  // Preserve the old field as the upgrade floor; new observations are local
  // counters and can commit while a newer source snapshot is being installed.
  const clockName = 'account_auth_checked:' + localpart;
  const [clock] = await conn.query('SELECT value FROM counters WHERE name=?', [
    clockName,
  ]);
  const checked = Math.max(Number(row.checked_ms), Number(clock?.value ?? 0));
  if (
    (!settings.allowstaleauth && !reconciled) || now < checked ||
    now < Number(row.captured_ms) ||
    (settings.authmaxstalehours > 0 &&
      now - Number(row.captured_ms) > settings.authmaxstalehours * 3600000)
  ) authUnavailable();
  if (now > checked) {
    await conn.execute(
      'INSERT INTO counters(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=MAX(counters.value,excluded.value)',
      [clockName, now],
    );
  }
}
