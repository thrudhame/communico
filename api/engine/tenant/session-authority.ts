// Device incarnations, issuer-bound session recovery and remove-wins facts.
// The tenant transaction owns these together with the existing materializations.
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Conn } from '#engine/store/db.ts';
import type { Row } from '#engine/store/ffi.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import { deleteDevice } from '#engine/tenant/devices.ts';
import { appendImportedKeyNotice } from '#engine/tenant/changes.ts';
import { recordTenantProjection } from '#engine/tenant/hooks.ts';
import {
  captureLegacyPusherOperations,
  deletePushersForToken,
} from '#engine/tenant/pushers.ts';
import { deactivateUserRows } from '#engine/tenant/users.ts';
import type { ErasureCut } from '#engine/room/state.ts';
import { authUnavailable } from '#engine/tenant/account-auth.ts';
import {
  legacySignatures,
  type RemoteSignatureCuts,
  retainLegacySignatures,
} from '#engine/tenant/signature-bootstrap.ts';

export const SESSION_AUTHORITY_SQL = `
CREATE TABLE tenant_authority(singleton INTEGER PRIMARY KEY CHECK(singleton=1),node TEXT NOT NULL,incarnation TEXT NOT NULL,home_incarnation TEXT NOT NULL,edge_node TEXT NOT NULL,edge_incarnation TEXT NOT NULL);
CREATE TABLE authority_facts(id TEXT PRIMARY KEY NOT NULL,node TEXT NOT NULL,incarnation TEXT NOT NULL,seq INTEGER NOT NULL,localpart TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(node,incarnation,seq));
CREATE INDEX authority_facts_account ON authority_facts(localpart,kind);
CREATE TABLE authority_devices(localpart TEXT NOT NULL,device_id TEXT NOT NULL,incarnation TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(localpart,device_id));
CREATE TABLE session_authority(hash TEXT PRIMARY KEY NOT NULL,node TEXT NOT NULL,incarnation TEXT NOT NULL,localpart TEXT NOT NULL,device_id TEXT,device_incarnation TEXT,barriers TEXT NOT NULL,refresh INTEGER NOT NULL,access_hash TEXT,next_hash TEXT,revision INTEGER NOT NULL);
`;

export type AuthorityIdentity = {
  node: string;
  incarnation: string;
  homeIncarnation: string;
  edgeNode: string;
  edgeIncarnation: string;
};
export type AuthorityFact = {
  id: string;
  node: string;
  incarnation: string;
  seq: number;
  localpart: string;
  kind: 'device' | 'delete' | 'revoke' | 'barrier' | 'deactivate';
  deviceId?: string;
  target?: string;
  erase?: boolean;
};
export type SessionFact = {
  hash: string;
  node: string;
  incarnation: string;
  localpart: string;
  deviceId: string | null;
  deviceIncarnation: string | null;
  barriers: string[];
  refresh: boolean;
  accessHash: string | null;
  nextHash: string | null;
  revision: number;
};

export function ownerUnavailable(): never {
  throw new MatrixError(
    503,
    'M_UNAVAILABLE',
    'operation owner unavailable at this ingress',
  );
}
function invalid(soft = false): never {
  throw new MatrixError(401, 'M_UNKNOWN_TOKEN', 'session authority revoked', {
    errcode: 'M_UNKNOWN_TOKEN',
    error: 'session authority revoked',
    ...(soft ? { soft_logout: true } : {}),
  });
}
export async function tenantAuthority(
  conn: Conn,
): Promise<AuthorityIdentity | null> {
  const [row] = await conn.query(
    'SELECT * FROM tenant_authority WHERE singleton=1',
  );
  return row
    ? {
      node: String(row.node),
      incarnation: String(row.incarnation),
      homeIncarnation: String(row.home_incarnation),
      edgeNode: String(row.edge_node),
      edgeIncarnation: String(row.edge_incarnation),
    }
    : null;
}

export async function activateTenantAuthority(
  conn: Conn,
  identity: AuthorityIdentity,
  remoteSignatureCuts?: RemoteSignatureCuts,
): Promise<void> {
  const held = await tenantAuthority(conn);
  if (held && canonicalJson(held) !== canonicalJson(identity)) {
    ownerUnavailable();
  }
  if (!held) {
    const signatures = identity.node === 'home'
      ? await legacySignatures(conn, remoteSignatureCuts)
      : [];
    await conn.execute('INSERT INTO tenant_authority VALUES(1,?,?,?,?,?)', [
      identity.node,
      identity.incarnation,
      identity.homeIncarnation,
      identity.edgeNode,
      identity.edgeIncarnation,
    ]);
    // Only home may assign pre-enrollment local devices. A facade's public
    // replicas are never converted into mutable device/session authority.
    if (identity.node === 'home') {
      for (
        const row of await conn.query(
          'SELECT localpart,device_id,generation FROM devices',
        )
      ) {
        await recordDeviceCreation(
          conn,
          String(row.localpart),
          String(row.device_id),
          Number(row.generation),
        );
      }
      for (
        const row of await conn.query(
          'SELECT token,localpart,device_id FROM access_tokens',
        )
      ) {
        await recordSession(
          conn,
          String(row.token),
          String(row.localpart),
          row.device_id === null ? null : String(row.device_id),
        );
      }
      for (
        const row of await conn.query(
          'SELECT token,localpart,device_id,access_token,next_token FROM refresh_tokens',
        )
      ) {
        await recordSession(
          conn,
          String(row.token),
          String(row.localpart),
          row.device_id === null ? null : String(row.device_id),
          String(row.access_token),
        );
        if (row.next_token !== null) {
          await recordRefreshReplacement(
            conn,
            String(row.token),
            String(row.next_token),
            String(row.access_token),
          );
        }
      }
    }
    await retainLegacySignatures(conn, signatures);
  }
  if (identity.node === 'home') await captureLegacyPusherOperations(conn);
}

export async function accountBarriers(
  conn: Conn,
  localpart: string,
): Promise<string[]> {
  return (await conn.query(
    "SELECT id FROM authority_facts WHERE localpart=? AND kind='barrier' ORDER BY id",
    [localpart],
  )).map((row) => String(row.id));
}

async function append(
  conn: Conn,
  localpart: string,
  content: Pick<AuthorityFact, 'kind' | 'deviceId' | 'target' | 'erase'>,
): Promise<AuthorityFact | null> {
  const identity = await tenantAuthority(conn);
  if (!identity) return null;
  const seq = await nextCounter(
    conn,
    'authority:' + identity.node + ':' + identity.incarnation,
  );
  const fact: AuthorityFact = {
    id: canonicalJson([identity.node, identity.incarnation, seq]),
    node: identity.node,
    incarnation: identity.incarnation,
    seq,
    localpart,
    ...content,
  };
  await conn.execute('INSERT INTO authority_facts VALUES(?,?,?,?,?,?,?)', [
    fact.id,
    fact.node,
    fact.incarnation,
    seq,
    localpart,
    fact.kind,
    canonicalJson(fact),
  ]);
  return fact;
}

export async function registryDevice(
  conn: Conn,
  localpart: string,
  deviceId: string,
): Promise<AuthorityFact | null> {
  const rows = await conn.query(
    "SELECT payload FROM authority_facts WHERE localpart=? AND kind='device'",
    [localpart],
  );
  return registryDeviceFromFacts(
    rows.map((row) => JSON.parse(String(row.payload)) as AuthorityFact),
    deviceId,
  );
}

function registryDeviceFromFacts(
  facts: readonly AuthorityFact[],
  deviceId: string,
) {
  const candidates = facts.filter((fact) =>
    fact.kind === 'device' && fact.deviceId === deviceId
  );
  candidates.sort((a, b) =>
    a.node === b.node ? b.seq - a.seq : a.node === 'home' ? -1 : 1
  );
  return candidates[0] ?? null;
}

export async function assertDeviceOwner(
  conn: Conn,
  localpart: string,
  deviceId: string,
): Promise<void> {
  const identity = await tenantAuthority(conn);
  if (!identity) return;
  const device = await registryDevice(conn, localpart, deviceId);
  if (
    device &&
    (device.node !== identity.node ||
      device.incarnation !== identity.incarnation)
  ) ownerUnavailable();
}

export async function recordDeviceCreation(
  conn: Conn,
  localpart: string,
  deviceId: string,
  generation: number,
): Promise<void> {
  if (!await tenantAuthority(conn)) return;
  await assertDeviceOwner(conn, localpart, deviceId);
  const fact = await append(conn, localpart, { kind: 'device', deviceId });
  await conn.execute(
    'INSERT INTO authority_devices VALUES(?,?,?,?) ON CONFLICT(localpart,device_id) DO UPDATE SET incarnation=excluded.incarnation,generation=excluded.generation',
    [localpart, deviceId, fact!.id, generation],
  );
}

export async function recordDeviceDeletion(
  conn: Conn,
  localpart: string,
  deviceId: string,
): Promise<void> {
  const device = await registryDevice(conn, localpart, deviceId);
  if (!device) return;
  if (
    !(await conn.query(
      "SELECT id FROM authority_facts WHERE kind='delete' AND localpart=? AND json_extract(payload,'$.target')=?",
      [localpart, device.id],
    )).length
  ) {
    await append(conn, localpart, {
      kind: 'delete',
      deviceId,
      target: device.id,
    });
  }
}

export async function recordRevocation(
  conn: Conn,
  hash: string,
): Promise<void> {
  const [session] = await conn.query(
    'SELECT localpart FROM session_authority WHERE hash=?',
    [hash],
  );
  if (!session) return;
  if (
    !(await conn.query(
      "SELECT id FROM authority_facts WHERE kind='revoke' AND localpart=? AND json_extract(payload,'$.target')=?",
      [session.localpart, hash],
    )).length
  ) {
    await append(conn, String(session.localpart), {
      kind: 'revoke',
      target: hash,
    });
  }
}

/** Revoke observed sessions and device incarnations, not the account: a
 * blanket barrier would also revoke the caller whose password change survives. */
export async function recordOtherSessionRevocations(
  conn: Conn,
  localpart: string,
  keepHash: string | null,
  keepDevice: string | null,
): Promise<void> {
  const view = await captureSessionAuthority(conn, localpart);
  for (const session of view.sessions) {
    if (
      keepHash !== null &&
      (session.hash === keepHash ||
        (session.refresh && session.accessHash === keepHash))
    ) continue;
    await recordRevocation(conn, session.hash);
  }
  for (
    const deviceId of new Set(
      view.facts.filter((fact) => fact.kind === 'device').map((fact) =>
        fact.deviceId!
      ),
    )
  ) {
    if (deviceId !== keepDevice) {
      await recordDeviceDeletion(conn, localpart, deviceId);
    }
  }
}

export async function recordLogoutBarrier(
  conn: Conn,
  localpart: string,
): Promise<void> {
  await append(conn, localpart, { kind: 'barrier' });
}

export async function recordDeactivation(
  conn: Conn,
  localpart: string,
  erase: boolean,
): Promise<void> {
  const prior = await conn.query(
    "SELECT payload FROM authority_facts WHERE localpart=? AND kind='deactivate'",
    [localpart],
  );
  if (
    !prior.length ||
    (erase && !prior.some((row) => JSON.parse(String(row.payload)).erase))
  ) {
    await append(conn, localpart, { kind: 'deactivate', erase });
  }
}

export async function recordSession(
  conn: Conn,
  hash: string,
  localpart: string,
  deviceId: string | null,
  accessHash: string | null = null,
): Promise<void> {
  const identity = await tenantAuthority(conn);
  if (!identity) return;
  let deviceIncarnation: string | null = null;
  if (deviceId !== null) {
    await assertDeviceOwner(conn, localpart, deviceId);
    const [mapping] = await conn.query(
      'SELECT incarnation FROM authority_devices WHERE localpart=? AND device_id=?',
      [localpart, deviceId],
    );
    if (!mapping) ownerUnavailable();
    deviceIncarnation = String(mapping.incarnation);
  }
  const [access] = accessHash === null
    ? []
    : await conn.query('SELECT barriers FROM session_authority WHERE hash=?', [
      accessHash,
    ]);
  if (accessHash !== null && !access) invalid();
  const barriers = access
    ? String(access.barriers)
    : canonicalJson(await accountBarriers(conn, localpart));
  await conn.execute(
    'INSERT INTO session_authority VALUES(?,?,?,?,?,?,?,?,?,NULL,1) ON CONFLICT(hash) DO NOTHING',
    [
      hash,
      identity.node,
      identity.incarnation,
      localpart,
      deviceId,
      deviceIncarnation,
      barriers,
      accessHash === null ? 0 : 1,
      accessHash,
    ],
  );
}

export async function recordRefreshReplacement(
  conn: Conn,
  hash: string,
  nextHash: string,
  accessHash: string,
): Promise<void> {
  await conn.execute(
    'UPDATE session_authority SET next_hash=?,access_hash=?,revision=revision+1 WHERE hash=?',
    [nextHash, accessHash, hash],
  );
}

/** Validate retained provenance and terminal facts without granting execution
 * at this ingress. Foreign session copies remain recovery-only material. */
export async function retainedSessionAuthority(
  conn: Conn,
  hash: string,
  refresh: boolean,
) {
  const [session] = await conn.query(
    'SELECT * FROM session_authority WHERE hash=? AND refresh=?',
    [hash, refresh ? 1 : 0],
  );
  if (!session) return null;
  const facts =
    (await conn.query('SELECT payload FROM authority_facts WHERE localpart=?', [
      session.localpart,
    ]))
      .map((row) => JSON.parse(String(row.payload)) as AuthorityFact);
  const [account] = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [session.localpart],
  );
  return validateRetainedSession(session, facts, account?.deactivated === 1);
}

function validateRetainedSession(
  session: Row,
  facts: readonly AuthorityFact[],
  deactivated: boolean,
) {
  if (
    deactivated || facts.some((fact) =>
      fact.kind === 'deactivate' ||
      (fact.kind === 'revoke' && fact.target === session.hash)
    )
  ) invalid();
  const observed = JSON.parse(String(session.barriers)) as string[];
  if (
    facts.some((fact) => fact.kind === 'barrier' && !observed.includes(fact.id))
  ) invalid();
  if (session.device_id !== null) {
    const current = registryDeviceFromFacts(facts, String(session.device_id));
    if (!current || current.id !== session.device_incarnation) {
      invalid(current?.node === 'home' && session.node !== 'home');
    }
    if (
      facts.some((fact) => fact.kind === 'delete' && fact.target === current.id)
    ) invalid();
  }
  return session;
}

/** Attempt-local batch input, not a second admission policy or a persistent cache. */
export async function captureRetainedSessionAuthorities(
  conn: Conn,
  hashes: readonly string[],
) {
  const sessions = new Map((await conn.query(
    'SELECT s.* FROM json_each(?) selected JOIN session_authority s ON s.hash=CAST(selected.value AS TEXT)',
    [JSON.stringify([...new Set(hashes)])],
  )).map((row) => [String(row.hash), row]));
  const users = JSON.stringify([
    ...new Set([...sessions.values()].map((row) => String(row.localpart))),
  ]);
  const facts = new Map<string, AuthorityFact[]>();
  for (
    const row of await conn.query(
      'SELECT f.localpart,f.payload FROM json_each(?) selected JOIN authority_facts f ON f.localpart=CAST(selected.value AS TEXT)',
      [users],
    )
  ) {
    const lp = String(row.localpart);
    const group = facts.get(lp) ?? [];
    group.push(JSON.parse(String(row.payload)) as AuthorityFact);
    facts.set(lp, group);
  }
  const accounts = new Map((await conn.query(
    'SELECT u.localpart,u.deactivated FROM json_each(?) selected JOIN users u ON u.localpart=CAST(selected.value AS TEXT)',
    [users],
  )).map((row) => [String(row.localpart), row.deactivated === 1]));
  return (hash: string, refresh: boolean) => {
    const session = sessions.get(hash);
    if (!session || session.refresh !== (refresh ? 1 : 0)) return null;
    const lp = String(session.localpart);
    return validateRetainedSession(
      session,
      facts.get(lp) ?? [],
      accounts.get(lp) ?? false,
    );
  };
}

export function assertSessionAuthorityOwner(
  identity: AuthorityIdentity | null,
  session: Row | null,
) {
  if (
    identity && session &&
    (session.node !== identity.node ||
      session.incarnation !== identity.incarnation)
  ) ownerUnavailable();
}

export async function requireSessionAuthority(
  conn: Conn,
  hash: string,
  refresh: boolean,
): Promise<void> {
  const identity = await tenantAuthority(conn);
  if (!identity) return;
  const session = await retainedSessionAuthority(conn, hash, refresh);
  // Unknown digests retain the normal lookup's null/401.
  assertSessionAuthorityOwner(identity, session);
}

export async function captureSessionAuthority(
  conn: Conn,
  localpart: string,
): Promise<{ facts: AuthorityFact[]; sessions: SessionFact[] }> {
  return {
    facts: (await conn.query(
      'SELECT payload FROM authority_facts WHERE localpart=? ORDER BY node,incarnation,seq',
      [localpart],
    )).map((row) => JSON.parse(String(row.payload))),
    sessions: (await conn.query(
      'SELECT * FROM session_authority WHERE localpart=? ORDER BY hash',
      [localpart],
    )).map((row) => ({
      hash: String(row.hash),
      node: String(row.node),
      incarnation: String(row.incarnation),
      localpart: String(row.localpart),
      deviceId: row.device_id === null ? null : String(row.device_id),
      deviceIncarnation: row.device_incarnation === null
        ? null
        : String(row.device_incarnation),
      barriers: JSON.parse(String(row.barriers)),
      refresh: row.refresh === 1,
      accessHash: row.access_hash === null ? null : String(row.access_hash),
      nextHash: row.next_hash === null ? null : String(row.next_hash),
      revision: Number(row.revision),
    })),
  };
}

function collision(): never {
  throw new MatrixError(409, 'M_UNKNOWN', 'authority fact collision');
}

/** Decode before either comparing or installing authority. Complete home cuts
 * carry their own dependencies; reverse cuts may refer to retained home facts. */
export function validateSessionAuthority(
  localpart: string,
  raw: unknown,
  options: {
    sources?: readonly { node: string; incarnation: string }[];
    complete?: boolean;
  } = {},
): { facts: AuthorityFact[]; sessions: SessionFact[] } {
  const object = (value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(raw)) collision();
  const view = raw as { facts: AuthorityFact[]; sessions: SessionFact[] };
  if (
    !Array.isArray(view.facts) || !Array.isArray(view.sessions) ||
    canonicalJson(Object.keys(view).sort()) !==
      canonicalJson(['facts', 'sessions'])
  ) collision();
  const validSource = (node: string, incarnation: string) =>
    typeof node === 'string' && node.length > 0 &&
    typeof incarnation === 'string' && incarnation.length > 0 &&
    (!options.sources ||
      options.sources.some((source) =>
        source.node === node && source.incarnation === incarnation
      ));
  const digest = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  const facts = new Map<string, AuthorityFact>();
  for (const fact of view.facts) {
    if (
      !object(fact) || !validSource(fact.node, fact.incarnation) ||
      fact.localpart !== localpart || !Number.isSafeInteger(fact.seq) ||
      fact.seq < 1 ||
      fact.id !== canonicalJson([fact.node, fact.incarnation, fact.seq])
    ) collision();
    const common = {
      id: fact.id,
      node: fact.node,
      incarnation: fact.incarnation,
      seq: fact.seq,
      localpart,
    };
    let expected: AuthorityFact;
    switch (fact.kind) {
      case 'device':
        if (typeof fact.deviceId !== 'string' || !fact.deviceId) collision();
        expected = { ...common, kind: 'device', deviceId: fact.deviceId };
        break;
      case 'delete':
        if (
          typeof fact.deviceId !== 'string' || !fact.deviceId ||
          typeof fact.target !== 'string' || !fact.target
        ) collision();
        expected = {
          ...common,
          kind: 'delete',
          deviceId: fact.deviceId,
          target: fact.target,
        };
        break;
      case 'revoke':
        if (!digest(fact.target)) collision();
        expected = { ...common, kind: 'revoke', target: fact.target };
        break;
      case 'barrier':
        expected = { ...common, kind: 'barrier' };
        break;
      case 'deactivate':
        if (typeof fact.erase !== 'boolean') collision();
        expected = { ...common, kind: 'deactivate', erase: fact.erase };
        break;
      default:
        collision();
    }
    if (
      canonicalJson(fact) !== canonicalJson(expected) ||
      (facts.has(fact.id) &&
        canonicalJson(facts.get(fact.id)) !== canonicalJson(fact))
    ) collision();
    facts.set(fact.id, fact);
  }
  const sessions = new Map<string, SessionFact>();
  for (const session of view.sessions) {
    if (
      !object(session) || !validSource(session.node, session.incarnation) ||
      session.localpart !== localpart || !digest(session.hash) ||
      typeof session.refresh !== 'boolean' ||
      !Number.isSafeInteger(session.revision) || session.revision < 1 ||
      !Array.isArray(session.barriers) || session.barriers.some((id) =>
        typeof id !== 'string'
      ) ||
      canonicalJson(session.barriers) !==
        canonicalJson([...new Set(session.barriers)].sort()) ||
      (session.deviceId !== null &&
        (typeof session.deviceId !== 'string' || !session.deviceId)) ||
      (session.deviceIncarnation !== null &&
        typeof session.deviceIncarnation !== 'string') ||
      (session.deviceId === null) !== (session.deviceIncarnation === null) ||
      (session.refresh
        ? !digest(session.accessHash)
        : session.accessHash !== null) ||
      (session.nextHash !== null &&
        (!session.refresh || !digest(session.nextHash))) ||
      canonicalJson(Object.keys(session).sort()) !== canonicalJson([
          'hash',
          'node',
          'incarnation',
          'localpart',
          'deviceId',
          'deviceIncarnation',
          'barriers',
          'refresh',
          'accessHash',
          'nextHash',
          'revision',
        ].sort()) ||
      (sessions.has(session.hash) &&
        canonicalJson(sessions.get(session.hash)) !== canonicalJson(session))
    ) collision();
    sessions.set(session.hash, session);
    if (options.complete) {
      const device = session.deviceIncarnation === null
        ? undefined
        : facts.get(session.deviceIncarnation);
      if (
        (session.deviceId !== null && (!device || device.kind !== 'device' ||
          device.node !== session.node ||
          device.incarnation !== session.incarnation ||
          device.deviceId !== session.deviceId)) ||
        session.barriers.some((id) => facts.get(id)?.kind !== 'barrier')
      ) collision();
    }
  }
  if (
    options.complete && view.facts.some((fact) =>
      fact.kind === 'delete' &&
      (facts.get(fact.target!)?.kind !== 'device' ||
        facts.get(fact.target!)?.deviceId !== fact.deviceId)
    )
  ) collision();
  return view;
}

export async function installSessionAuthority(
  conn: Conn,
  localpart: string,
  view: { facts: AuthorityFact[]; sessions: SessionFact[] },
  erasureCuts?: Record<string, ErasureCut>,
): Promise<void> {
  const identity = await tenantAuthority(conn);
  if (!identity) ownerUnavailable();
  validateSessionAuthority(localpart, view, {
    sources: [
      { node: 'home', incarnation: identity.homeIncarnation },
      { node: identity.edgeNode, incarnation: identity.edgeIncarnation },
    ],
  });
  const [beforeNews] = await conn.query(
    "SELECT value FROM counters WHERE name='e2ee_changes'",
  );
  let changed = false, publicChanged = false;
  const facts = new Map((await conn.query(
    'SELECT id,payload FROM authority_facts WHERE localpart=?',
    [localpart],
  )).map((row) => [String(row.id), String(row.payload)]));
  for (const fact of view.facts) {
    const payload = canonicalJson(fact);
    let old = facts.get(fact.id);
    if (old === undefined) {
      // IDs are global across accounts. Only new local facts need this lookup;
      // retained immutable facts were already validated at their admission cut.
      const [other] = await conn.query(
        'SELECT payload FROM authority_facts WHERE id=?',
        [fact.id],
      );
      if (other) old = String(other.payload);
    }
    if (old !== undefined) {
      if (old !== payload) collision();
      continue;
    }
    changed = true;
    publicChanged ||= fact.kind === 'device' || fact.kind === 'delete' ||
      fact.kind === 'deactivate';
    await conn.execute(
      'INSERT INTO authority_facts VALUES(?,?,?,?,?,?,?)',
      [
        fact.id,
        fact.node,
        fact.incarnation,
        fact.seq,
        localpart,
        fact.kind,
        payload,
      ],
    );
    facts.set(fact.id, payload);
  }
  const sessions = new Map((await conn.query(
    'SELECT * FROM session_authority WHERE localpart=?',
    [localpart],
  )).map((row) => [String(row.hash), row]));
  for (const session of view.sessions) {
    const old = sessions.get(session.hash) ?? (await conn.query(
      'SELECT * FROM session_authority WHERE hash=?',
      [session.hash],
    ))[0];
    if (session.deviceId !== null) {
      const device = facts.get(session.deviceIncarnation!);
      if (!device) collision();
      const fact = JSON.parse(device) as AuthorityFact;
      if (
        fact.kind !== 'device' ||
        fact.node !== session.node ||
        fact.incarnation !== session.incarnation ||
        fact.deviceId !== session.deviceId
      ) collision();
    }
    for (const barrier of session.barriers) {
      const fact = facts.get(barrier);
      if (
        !fact || (JSON.parse(fact) as AuthorityFact).kind !== 'barrier'
      ) collision();
    }
    const immutable = [
      session.node,
      session.incarnation,
      localpart,
      session.deviceId,
      session.deviceIncarnation,
      canonicalJson(session.barriers),
      session.refresh ? 1 : 0,
    ];
    if (old) {
      if (
        canonicalJson([
          old.node,
          old.incarnation,
          old.localpart,
          old.device_id,
          old.device_incarnation,
          old.barriers,
          old.refresh,
        ]) !== canonicalJson(immutable)
      ) collision();
      if (Number(old.revision) > session.revision) continue;
      if (Number(old.revision) === session.revision) {
        if (
          old.access_hash !== session.accessHash ||
          old.next_hash !== session.nextHash
        ) collision();
        continue;
      }
      if (
        !session.refresh ||
        (old.next_hash !== null && session.nextHash === null)
      ) collision();
      // Only protected recovery metadata changes. Foreign records never enter
      // access_tokens/refresh_tokens or become independently usable sessions.
      await conn.execute(
        'UPDATE session_authority SET access_hash=?,next_hash=?,revision=? WHERE hash=?',
        [session.accessHash, session.nextHash, session.revision, session.hash],
      );
    } else {
      await conn.execute(
        'INSERT INTO session_authority VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        [
          session.hash,
          ...immutable,
          session.accessHash,
          session.nextHash,
          session.revision,
        ],
      );
    }
    sessions.set(session.hash, {
      hash: session.hash,
      node: session.node,
      incarnation: session.incarnation,
      localpart,
      device_id: session.deviceId,
      device_incarnation: session.deviceIncarnation,
      barriers: canonicalJson(session.barriers),
      refresh: session.refresh ? 1 : 0,
      access_hash: session.accessHash,
      next_hash: session.nextHash,
      revision: session.revision,
    });
  }
  for (const payload of facts.values()) {
    const deletion = JSON.parse(payload) as AuthorityFact;
    if (deletion.kind !== 'delete') continue;
    const target = facts.get(deletion.target!);
    if (
      !target ||
      (JSON.parse(target) as AuthorityFact).kind !== 'device' ||
      (JSON.parse(target) as AuthorityFact).deviceId !==
        deletion.deviceId
    ) collision();
  }
  for (
    const mapping of await conn.query(
      'SELECT a.* FROM authority_devices a JOIN devices d ON d.localpart=a.localpart AND d.device_id=a.device_id WHERE a.localpart=?',
      [localpart],
    )
  ) {
    const winner = await registryDevice(
      conn,
      localpart,
      String(mapping.device_id),
    );
    const deleted = await conn.query(
      "SELECT id FROM authority_facts WHERE localpart=? AND kind='delete' AND json_extract(payload,'$.target')=?",
      [localpart, mapping.incarnation],
    );
    if (winner?.id !== mapping.incarnation || deleted.length) {
      await deleteDevice(conn, String(mapping.device_id), localpart, false);
    }
  }
  if (
    (await conn.query(
      "SELECT id FROM authority_facts WHERE localpart=? AND kind='deactivate'",
      [localpart],
    )).length
  ) {
    const [tenant] = await conn.query('SELECT server_name FROM tenant');
    const erase = (await conn.query(
      "SELECT id FROM authority_facts WHERE localpart=? AND kind='deactivate' AND json_extract(payload,'$.erase')=1",
      [localpart],
    )).length > 0;
    if (
      erase && erasureCuts === undefined &&
      !(await conn.query(
        'SELECT localpart FROM erased_users WHERE localpart=?',
        [localpart],
      )).length
    ) authUnavailable();
    await deactivateUserRows(
      conn,
      String(tenant.server_name),
      localpart,
      erase ? erasureCuts : undefined,
      true,
    );
  }
  // Replica revocation must also cancel issuer-local push/refresh work. Keeping
  // only an HTTP gate would leave already registered workers authorized.
  for (const table of ['access_tokens', 'refresh_tokens']) {
    for (
      const row of await conn.query(
        `SELECT token FROM ${table} WHERE localpart=?`,
        [localpart],
      )
    ) {
      const hash = String(row.token);
      try {
        await requireSessionAuthority(conn, hash, table === 'refresh_tokens');
      } catch (error) {
        if (!(error instanceof MatrixError) || error.status !== 401) {
          throw error;
        }
        if (table === 'access_tokens') {
          await deletePushersForToken(conn, hash, false);
          await conn.execute(
            'DELETE FROM refresh_tokens WHERE access_token=?',
            [hash],
          );
        }
        await conn.execute(`DELETE FROM ${table} WHERE token=?`, [hash]);
      }
    }
  }
  if (changed) {
    const [afterNews] = await conn.query(
      "SELECT value FROM counters WHERE name='e2ee_changes'",
    );
    if (
      publicChanged &&
      Number(afterNews?.value ?? 0) === Number(beforeNews?.value ?? 0)
    ) {
      const [tenant] = await conn.query('SELECT server_name FROM tenant');
      await appendImportedKeyNotice(
        conn,
        localpart,
        '@' + localpart + ':' + tenant.server_name,
        true,
      );
    } else {
      // Local deletion/deactivation already retained its own key intent; all
      // authority changes still need durable discovery for cancelled owner work.
      await recordTenantProjection(conn);
    }
  }
}
