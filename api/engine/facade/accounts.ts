// Pinned-link adapter for home-authorized credential/status snapshots. The
// tenant owner installs semantic state; journal ACK follows its durable commit.
import { canonicalJson } from '#engine/canonical.ts';
import {
  importPublicKeyFromRaw,
  matrixBase64,
} from '#engine/signing-primitives.js';
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import {
  type AccountAuth,
  captureAccountAuth,
  installAccountAuth,
} from '#engine/tenant/account-auth.ts';
import { checkLocalpart } from '#engine/tenant/users.ts';
import { appendRecord, type Journal } from './journal.ts';
import type { OwnerControls } from './ownership.ts';
import type { Pairings } from './pairing.ts';
import { integer, LinkError, object, type Stream, text } from './protocol.ts';
import { applyReplicaScope } from './scopes.ts';

function accountAuthOf(raw: unknown): AccountAuth {
  const row = object(raw);
  const localpart = text(row.localpart);
  if (
    row.kind !== 'account-auth' || checkLocalpart(localpart) !== localpart ||
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
    private readonly owners: Pick<OwnerControls, 'ready'>,
  ) {}

  async apply(journal: Journal, stream: Stream): Promise<boolean> {
    const record = await journal.next('home', stream);
    if (!record) return false;
    if (record.type !== 'account-auth' || record.version !== 1) {
      throw new LinkError('LINK_CAPABILITY_MISMATCH', 'not account auth');
    }
    const payload = object(record.payload), signed = object(payload.signed);
    const view = accountAuthOf(signed.body);
    const grant = await this.pairings.active();
    const owner = await this.owners.ready();
    const context = grant.body.transcript.body.context;
    if (
      view.server !== this.tenant.serverName ||
      view.server !== context.server || view.pairing !== context.id ||
      view.grantRevision !== grant.body.revision ||
      view.ownerRevision !== owner.revision || owner.pairing !== view.pairing
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
        await importPublicKeyFromRaw(matrixBase64(context.home.publicKey, 32)),
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
    return await applyReplicaScope({
      db: await this.store.server(),
      pairings: this.pairings,
      self: this.tenant.serverName,
      journal,
      stream,
      record,
      scope: 'auth:@' + view.localpart + ':' + view.server,
      after: integer(payload.after),
      cut: view.sourceCut,
      apply: async () => {
        await (await this.store.tenant(view.server)).tx((conn) =>
          installAccountAuth(conn, view)
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
