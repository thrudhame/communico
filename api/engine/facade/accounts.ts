// Pinned-link adapter for home-authorized credential/status snapshots. The
// tenant owner installs semantic state; journal ACK follows its durable commit.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  importPublicKeyFromRaw,
  matrixBase64,
} from '#engine/signing-primitives.js';
import type { Store } from '#engine/store/index.ts';
import {
  keyChangesCut,
  publicKeysChangedAfter,
} from '#engine/tenant/changes.ts';
import type { Conn } from '#engine/store/db.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import {
  type AccountAuth,
  accountAuthSupersedes,
  captureAccountAuth,
  publishAccountAuth,
} from '#engine/tenant/account-auth.ts';
import { checkLocalpart, userByLocalpart } from '#engine/tenant/users.ts';
import {
  captureSessionAuthority,
  installSessionAuthority,
  tenantAuthority,
  validateSessionAuthority,
} from '#engine/tenant/session-authority.ts';
import { captureErasureCuts } from '#engine/tenant/erasure.ts';
import {
  pendingTenantProjection,
  tenantChangesCommitted,
} from '#engine/tenant/hooks.ts';
import { appendRecord, type Journal } from './journal.ts';
import type { OwnerControls } from './ownership.ts';
import type { Grant, Pairings } from './pairing.ts';
import type { NodeIdentity } from './identity.ts';
import {
  integer,
  LinkError,
  type LinkRecord,
  object,
  type Stream,
  text,
} from './protocol.ts';
import { applyReplicaScope } from './scopes.ts';
import { onTenantStream } from '#engine/tenant/streams.ts';
import { requireAccountSelection } from './domain-control.ts';

type AuthorityCut = AccountAuth['authority'];
type SessionAuthority = {
  kind: 'session-authority';
  server: string;
  pairing: string;
  grantRevision: number;
  ownerRevision: number;
  localpart: string;
  source: string;
  incarnation: string;
  authority: AuthorityCut;
};

function mismatch(message: string): never {
  throw new LinkError('LINK_IDENTITY_MISMATCH', message, 403);
}

function accountLocalpart(localpart: string): string {
  try {
    return checkLocalpart(localpart);
  } catch (error) {
    if (
      !(error instanceof MatrixError) || error.status !== 400 ||
      error.errcode !== 'M_INVALID_USERNAME'
    ) throw error;
    throw new LinkError('LINK_BAD_RECORD', 'invalid account localpart', 400);
  }
}

function authorityCutOf(
  raw: unknown,
  localpart: string,
  options: Parameters<typeof validateSessionAuthority>[2] = {},
): AuthorityCut {
  try {
    return validateSessionAuthority(localpart, raw, options);
  } catch (error) {
    if (!(error instanceof MatrixError) || error.status !== 409) throw error;
    throw new LinkError(
      'LINK_BAD_RECORD',
      'invalid session authority cut',
      400,
    );
  }
}

function sessionAuthorityOf(raw: unknown): SessionAuthority {
  const row = object(raw);
  if (row.kind !== 'session-authority') {
    throw new LinkError(
      'LINK_BAD_RECORD',
      'invalid session authority cut',
      400,
    );
  }
  const localpart = text(row.localpart);
  if (accountLocalpart(localpart) !== localpart) {
    mismatch('invalid authority account');
  }
  const view: SessionAuthority = {
    kind: 'session-authority',
    server: text(row.server),
    pairing: text(row.pairing),
    grantRevision: integer(row.grantRevision, 1),
    ownerRevision: integer(row.ownerRevision, 1),
    localpart,
    source: text(row.source),
    incarnation: text(row.incarnation),
    authority: authorityCutOf(row.authority, localpart),
  };
  if (canonicalJson(view) !== canonicalJson(raw)) {
    mismatch('unexpected session authority material');
  }
  // A facade may contribute its OWN facts/recovery chains only, never mint or
  // replace home facts already carried by a home-authenticated account cut.
  for (const raw of [...view.authority.facts, ...view.authority.sessions]) {
    const item = object(raw);
    if (
      item.node !== view.source || item.incarnation !== view.incarnation ||
      item.localpart !== localpart
    ) {
      mismatch('session authority contains another source');
    }
  }
  for (const raw of view.authority.sessions) {
    if (
      canonicalJson(Object.keys(raw).sort()) !== canonicalJson([
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
      ].sort())
    ) mismatch('unexpected session recovery material');
  }
  return view;
}

async function assertBinding(
  conn: Conn,
  grant: Grant,
  side: 'home' | 'facade',
) {
  const [binding] = await conn.query(
    'SELECT state,grant_json FROM facade_pairings WHERE id=? AND side=?',
    [grant.body.transcript.body.context.id, side],
  );
  if (
    binding?.state !== 'paired' || binding.grant_json !== canonicalJson(grant)
  ) {
    throw new LinkError(
      'LINK_UNPAIRED',
      'session authority grant changed',
      403,
    );
  }
}

async function requireControl(conn: Conn, view: SessionAuthority) {
  const [control] = await conn.query(
    'SELECT a.revision,c.signed_json FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision WHERE a.pairing=?',
    [view.pairing],
  );
  if (!control || Number(control.revision) < view.ownerRevision) {
    throw new LinkError(
      'LINK_UNAVAILABLE',
      'session authority awaits ownership control',
      503,
    );
  }
  const body = JSON.parse(String(control.signed_json)).body;
  if (
    body.grantRevision !== view.grantRevision ||
    body.nodes[1].node !== view.source ||
    body.nodes[1].incarnation !== view.incarnation
  ) {
    mismatch('session authority differs from ownership control');
  }
}

/** Digest-only reverse exchange, pulled by home on the existing link. No PHC,
 * bearer plaintext, foreign-authored fact or independent token materialization. */
export async function exportSessionAuthority(
  store: Store,
  tenant: Tenant,
  pairings: Pairings,
  owners: Pick<OwnerControls, 'ready'>,
  node: Pick<NodeIdentity, 'node' | 'incarnation' | 'signer'>,
  localpart: string,
) {
  const grant = await pairings.active(), owner = await owners.ready();
  const context = grant.body.transcript.body.context;
  if (
    owner.pairing !== context.id || node.node !== context.node ||
    node.incarnation !== grant.body.transcript.body.incarnation
  ) mismatch('wrong exporting authority');
  const db = await store.tenant(tenant.serverName);
  const authority = await db.tx(async (conn) => {
    await requireAccountSelection(conn, {
      localpart,
      pairing: context.id,
      grantRevision: grant.body.revision,
    });
    const view = await captureSessionAuthority(conn, localpart);
    return {
      facts: view.facts.filter((fact) =>
        fact.node === node.node && fact.incarnation === node.incarnation
      ),
      sessions: view.sessions.filter((session) =>
        session.node === node.node && session.incarnation === node.incarnation
      ),
    };
  });
  const body: SessionAuthority = sessionAuthorityOf({
    kind: 'session-authority',
    server: tenant.serverName,
    pairing: context.id,
    grantRevision: grant.body.revision,
    ownerRevision: owner.revision,
    localpart,
    source: node.node,
    incarnation: node.incarnation,
    authority,
  });
  const signed = {
    body,
    signature: await node.signer().sign(canonicalJson(body)),
  };
  return await (await store.server()).tx(async (conn) => {
    await assertBinding(conn, grant, 'facade');
    await requireControl(conn, body);
    return await appendRecord(conn, 'home', {
      source: node.node,
      incarnation: node.incarnation,
      stream: 'authority:@' + localpart + ':' + tenant.serverName,
      type: 'account-auth',
      version: 1,
      operationId: 'authority:' +
        createHash('sha256').update(canonicalJson(body)).digest('hex'),
      payload: signed,
    });
  });
}

function accountAuthOf(
  raw: unknown,
  sources: readonly { node: string; incarnation: string }[],
): AccountAuth {
  const row = object(raw);
  const localpart = text(row.localpart);
  if (
    row.kind !== 'account-auth' || accountLocalpart(localpart) !== localpart ||
    typeof row.credentials !== 'boolean' ||
    typeof row.deactivated !== 'boolean' ||
    (row.phc !== null &&
      (typeof row.phc !== 'string' || !row.phc.startsWith('$argon2id$'))) ||
    ((!row.credentials || row.deactivated) && row.phc !== null)
  ) {
    throw new LinkError(
      'LINK_BAD_RECORD',
      'invalid account auth snapshot',
      400,
    );
  }
  const view: AccountAuth = {
    kind: 'account-auth',
    server: text(row.server),
    pairing: text(row.pairing),
    grantRevision: integer(row.grantRevision, 1),
    ownerRevision: integer(row.ownerRevision, 1),
    localpart,
    sourceCut: integer(row.sourceCut, 1),
    revision: integer(row.revision, 1),
    capturedMs: integer(row.capturedMs),
    credentials: row.credentials,
    phc: row.phc as string | null,
    deactivated: row.deactivated,
    ...(Object.hasOwn(row, 'deviceStreamFloor')
      ? { deviceStreamFloor: integer(row.deviceStreamFloor) }
      : {}),
    authority: authorityCutOf(row.authority, localpart, {
      sources,
      complete: true,
    }),
  };
  if (canonicalJson(view) !== canonicalJson(raw)) {
    throw new LinkError(
      'LINK_BAD_RECORD',
      'unexpected account auth material',
      400,
    );
  }
  return view;
}

export async function exportAccountAuth(
  store: Store,
  tenant: Tenant,
  pairings: Pairings,
  pairing: string,
  localpart: string,
  credentials: boolean,
  now = Date.now(),
) {
  const connection = await pairings.connection(pairing);
  const grant = connection.grant;
  if (connection.state !== 'paired' || !grant) {
    throw new LinkError(
      'LINK_UNPAIRED',
      'account auth export requires paired home',
      403,
    );
  }
  const server = await store.server();
  const scope = 'auth:@' + localpart + ':' + tenant.serverName;
  for (;;) {
    const [prior] = await server.query(
      'SELECT source_cut FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
      [connection.context.node, pairing, scope],
    );
    const after = Number(prior?.source_cut ?? 0);
    const [activation] = await server.query(
      'SELECT revision FROM facade_owner_activation WHERE pairing=?',
      [pairing],
    );
    if (!activation) {
      throw new LinkError(
        'LINK_UNAVAILABLE',
        'account auth requires ownership control',
        503,
      );
    }
    const view = await (await store.tenant(tenant.serverName)).tx((conn) =>
      captureAccountAuth(
        conn,
        {
          server: tenant.serverName,
          pairing,
          grantRevision: grant.body.revision,
          ownerRevision: Number(activation.revision),
        },
        localpart,
        credentials,
        now,
      )
    );
    const signed = {
      body: view,
      signature: await tenant.signer().sign(canonicalJson(view)),
    };
    const record = await server.tx(async (conn) => {
      const [binding] = await conn.query(
        "SELECT state,grant_json FROM facade_pairings WHERE id=? AND side='home'",
        [pairing],
      );
      if (
        binding?.state !== 'paired' ||
        binding.grant_json !== canonicalJson(grant)
      ) throw new LinkError('LINK_UNPAIRED', 'account auth grant changed', 403);
      const [current] = await conn.query(
        'SELECT source_cut FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
        [connection.context.node, pairing, scope],
      );
      if (Number(current?.source_cut ?? 0) !== after) return null;
      const record = await appendRecord(conn, connection.context.node, {
        source: 'home',
        incarnation: pairing,
        stream: scope,
        type: 'account-auth',
        version: 1,
        operationId: `auth:${pairing}:${localpart}:${view.sourceCut}`,
        payload: { after, signed },
      });
      await conn.execute(
        'INSERT INTO facade_exports(peer,incarnation,scope,source_cut) VALUES(?,?,?,?) ON CONFLICT(peer,incarnation,scope) DO UPDATE SET source_cut=excluded.source_cut',
        [connection.context.node, pairing, scope, view.sourceCut],
      );
      return record;
    });
    if (record) return record;
  }
}

export class AccountSnapshots {
  constructor(
    private readonly store: Store,
    private readonly tenant: Tenant,
    private readonly pairings: Pairings,
    private readonly owners?: Pick<OwnerControls, 'ready'>,
  ) {}

  async applyFromFacade(
    journal: Journal,
    pairing: string,
    stream: Stream,
  ): Promise<boolean> {
    const connection = await this.pairings.connection(pairing);
    const grant = connection.grant;
    if (connection.state !== 'paired' || !grant) {
      mismatch('session authority requires paired home');
    }
    const context = connection.context, transcript = grant.body.transcript.body;
    const record = await journal.next(context.node, stream);
    if (!record) return false;
    if (record.type !== 'account-auth' || record.version !== 1) {
      throw new LinkError('LINK_CAPABILITY_MISMATCH', 'not session authority');
    }
    const signed = object(record.payload),
      view = sessionAuthorityOf(signed.body);
    if (
      view.server !== this.tenant.serverName ||
      view.server !== context.server ||
      view.pairing !== pairing || view.grantRevision !== grant.body.revision ||
      view.source !== context.node ||
      view.incarnation !== transcript.incarnation ||
      record.source !== view.source ||
      record.incarnation !== view.incarnation ||
      record.stream !== 'authority:@' + view.localpart + ':' + view.server
    ) {
      mismatch('session authority differs from enrolled source or scope');
    }
    let valid = false;
    try {
      valid = await crypto.subtle.verify(
        'Ed25519',
        await importPublicKeyFromRaw(
          matrixBase64(transcript.key.publicKey, 32),
        ),
        matrixBase64(text(signed.signature), 64),
        new TextEncoder().encode(canonicalJson(view)),
      );
    } catch { /* Malformed signature grants no session authority. */ }
    if (!valid) mismatch('invalid facade session authority signature');
    const check = async (conn: Conn) => {
      await assertBinding(conn, grant, 'home');
      await requireControl(conn, view);
      const [selected] = await conn.query(
        'SELECT source_cut FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
        [context.node, pairing, 'auth:@' + view.localpart + ':' + view.server],
      );
      if (!selected) mismatch('session authority account not selected');
    };
    await (await this.store.server()).tx(check);
    const cuts =
      view.authority.facts.some((fact) =>
          fact.kind === 'deactivate' && fact.erase
        )
        ? await captureErasureCuts(this.store)
        : undefined;
    const { projectionRevision, publicKeysChanged } =
      await (await this.store.tenant(view.server)).tx(
        async (conn) => {
          await requireControl(conn, view);
          const identity = await tenantAuthority(conn);
          if (
            identity?.node !== 'home' || identity.edgeNode !== view.source ||
            identity.edgeIncarnation !== view.incarnation ||
            !await userByLocalpart(conn, view.localpart)
          ) {
            mismatch('session authority tenant is not the selected home');
          }
          const keyCut = await keyChangesCut(conn);
          await installSessionAuthority(
            conn,
            view.localpart,
            view.authority,
            cuts,
          );
          return {
            projectionRevision: await pendingTenantProjection(conn),
            publicKeysChanged: await publicKeysChangedAfter(conn, keyCut),
          };
        },
      );
    await tenantChangesCommitted(
      this.store,
      view.server,
      projectionRevision,
      false,
      'replica',
      publicKeysChanged,
    );
    return await journal.apply(context.node, stream, async (conn, current) => {
      await check(conn);
      if (current.hash !== record.hash) {
        throw new LinkError(
          'LINK_DIVERGED',
          'session authority application raced',
        );
      }
      return { localpart: view.localpart };
    });
  }

  async apply(journal: Journal, stream: Stream): Promise<boolean> {
    const pending = await journal.pending('home', stream);
    const first = pending[0];
    if (!first) return false;
    const grant = await this.pairings.active();
    if (!this.owners) mismatch('account snapshots require facade ownership');
    const owner = await this.owners.ready();
    const context = grant.body.transcript.body.context;
    const verify = async (record: LinkRecord) => {
      if (record.type !== 'account-auth' || record.version !== 1) {
        throw new LinkError('LINK_CAPABILITY_MISMATCH', 'not account auth');
      }
      const payload = object(record.payload), signed = object(payload.signed);
      const view = accountAuthOf(signed.body, owner.nodes);
      if (
        view.server !== this.tenant.serverName ||
        view.server !== context.server || view.pairing !== context.id ||
        view.grantRevision !== grant.body.revision ||
        owner.pairing !== view.pairing
      ) {
        throw new LinkError(
          'LINK_IDENTITY_MISMATCH',
          'account auth differs from enrolled authority',
          403,
        );
      }
      let valid = false;
      try {
        valid = await crypto.subtle.verify(
          'Ed25519',
          await importPublicKeyFromRaw(
            matrixBase64(context.home.publicKey, 32),
          ),
          matrixBase64(text(signed.signature), 64),
          new TextEncoder().encode(canonicalJson(view)),
        );
      } catch { /* Malformed signature grants no credential authority. */ }
      if (!valid) {
        throw new LinkError(
          'LINK_IDENTITY_MISMATCH',
          'invalid home account auth signature',
          403,
        );
      }
      return { record, view, after: integer(payload.after) };
    };
    const db = await this.store.server();
    const [scope] = await db.query(
      'SELECT pending_hash FROM facade_scopes WHERE incarnation=? AND scope=?',
      [context.id, stream.stream],
    );
    // An interrupted cross-file application resumes its originally admitted
    // finite prefix, even if receipt continued while it was being installed.
    const end = scope?.pending_hash
      ? pending.findIndex((record) => record.hash === scope.pending_hash)
      : pending.length - 1;
    if (end < 0) {
      throw new LinkError(
        'LINK_DIVERGED',
        'pending auth snapshot is not retained',
      );
    }
    let selected = await verify(first);
    const superseded: typeof selected[] = [];
    for (const candidate of pending.slice(1, end + 1)) {
      let next: typeof selected;
      try {
        next = await verify(candidate);
      } catch (error) {
        // A later invalid record cannot erase an earlier valid revocation. It
        // remains pending and will receive its normal refusal on the next turn.
        if (error instanceof LinkError) break;
        throw error;
      }
      if (
        next.after !== selected.view.sourceCut ||
        !accountAuthSupersedes(selected.view, next.view)
      ) break;
      superseded.push(selected);
      selected = next;
    }
    const { record, view } = selected;
    // Control and auth streams progress independently. Only authenticated old
    // snapshots can be retired; future snapshots wait for their control. Repeat
    // in each owning transaction so an asynchronous control advance cannot
    // install old credentials or publish obsolete readiness.
    const current = async (conn: Conn) => {
      const [activation] = await conn.query(
        'SELECT revision FROM facade_owner_activation WHERE pairing=?',
        [view.pairing],
      );
      if (!activation || Number(activation.revision) < view.ownerRevision) {
        throw new LinkError(
          'LINK_UNAVAILABLE',
          'account auth awaits ownership control',
          503,
        );
      }
      return Number(activation.revision) === view.ownerRevision;
    };
    return await applyReplicaScope({
      db,
      pairings: this.pairings,
      self: this.tenant.serverName,
      journal,
      stream,
      record,
      scope: 'auth:@' + view.localpart + ':' + view.server,
      after: superseded[0]?.after ?? selected.after,
      cut: view.sourceCut,
      superseded: superseded.map((entry) => ({
        record: entry.record,
        result: {
          localpart: entry.view.localpart,
          cut: entry.view.sourceCut,
          revision: entry.view.revision,
          supersededBy: record.sequence,
        },
      })),
      ready: current,
      apply: async () => {
        const cuts = view.authority.facts.some((fact) =>
            fact.kind === 'deactivate' && fact.erase
          )
          ? await captureErasureCuts(this.store)
          : undefined;
        const { projectionRevision, publicKeysChanged } =
          await (await this.store.tenant(view.server))
            .tx(async (conn) => {
              const keyCut = await keyChangesCut(conn);
              if (await current(conn)) {
                await publishAccountAuth(conn, view, record, cuts);
              }
              return {
                projectionRevision: await pendingTenantProjection(conn),
                publicKeysChanged: await publicKeysChangedAfter(conn, keyCut),
              };
            });
        await tenantChangesCommitted(
          this.store,
          view.server,
          projectionRevision,
          false,
          'replica',
          publicKeysChanged,
        );
        return {
          localpart: view.localpart,
          cut: view.sourceCut,
          revision: view.revision,
        };
      },
    });
  }
}

/** Per-account fair exporter. Mutations wake it promptly; periodic scans also
 * recover a missed notification/restart and publish fresh home auth cuts. */
export function startAccountExports(options: {
  store: Store;
  tenant: Tenant;
  pollseconds: number;
  users(): Promise<string[]>;
  emit(localpart: string): Promise<unknown>;
  changed(): void;
  failed(error: unknown): void;
}) {
  let stopped = false, dirty = false;
  let scanning: Promise<void> | undefined;
  const running = new Map<string, Promise<void>>();
  const rerun = new Set<string>();
  const wake = () => {
    if (stopped) return;
    dirty = true;
    scanning ??= (async () => {
      try {
        do {
          dirty = false;
          for (const user of await options.users()) {
            if (stopped) break;
            if (running.has(user)) {
              rerun.add(user);
              continue;
            }
            const work = (async () => {
              try {
                do {
                  rerun.delete(user);
                  try {
                    await options.emit(user);
                    options.changed();
                  } catch (error) {
                    options.failed(error);
                  }
                } while (!stopped && rerun.delete(user));
              } finally {
                running.delete(user);
              }
            })();
            running.set(user, work);
          }
        } while (!stopped && dirty);
      } catch (error) {
        options.failed(error);
      } finally {
        scanning = undefined;
      }
    })();
  };
  const untenant = onTenantStream((store, name, source) => {
    if (
      source === 'local' && store === options.store &&
      name === options.tenant.serverName
    ) wake();
  });
  const timer = setInterval(wake, options.pollseconds * 1000);
  let closed: Promise<void> | undefined;
  wake();
  return {
    wake,
    close: () =>
      closed ??= (async () => {
        stopped = true;
        clearInterval(timer);
        untenant();
        await scanning;
        await Promise.all(running.values());
      })(),
  };
}
