// Membership source export is separate from room-DAG replication and admission.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { checkLocalpart } from '#engine/tenant/users.ts';
import {
  type MembershipOperation,
  membershipOperations,
} from '#engine/server/membership-operations.ts';
import { type DomainBinding, requireDomainControl } from './domain-control.ts';
import type { NodeIdentity } from './identity.ts';
import { appendRecord } from './journal.ts';
import type { OwnerControl } from './ownership.ts';
import type { Grant, Pairings } from './pairing.ts';
import { LinkError, type LinkRecord } from './protocol.ts';
import { signingFence } from './signing-authority.ts';

type MembershipView = DomainBinding & {
  kind: 'membership-operation';
  operation: MembershipOperation;
};

function mismatch(message: string): never {
  throw new LinkError('LINK_IDENTITY_MISMATCH', message, 403);
}

export class MembershipOperations {
  constructor(
    private readonly store: Store,
    private readonly tenant: Tenant,
    private readonly pairings: Pairings,
    private readonly node?: Pick<
      NodeIdentity,
      'node' | 'incarnation' | 'signer'
    >,
  ) {}

  private async binding(pairing?: string) {
    let grant: Grant;
    if (this.node) {
      grant = await this.pairings.active();
      if (pairing && pairing !== grant.body.transcript.body.context.id) {
        mismatch('wrong membership pairing');
      }
    } else {
      if (!pairing) mismatch('home membership exchange requires pairing');
      const connection = await this.pairings.connection(pairing);
      if (connection.state !== 'paired' || !connection.grant) {
        mismatch('membership exchange requires paired home');
      }
      grant = connection.grant;
    }
    const context = grant.body.transcript.body.context;
    if (
      context.server !== this.tenant.serverName || (this.node &&
        (context.node !== this.node.node ||
          grant.body.transcript.body.incarnation !== this.node.incarnation))
    ) {
      mismatch('membership exchange differs from enrolled node');
    }
    return grant;
  }

  private async selected(conn: Conn, grant: Grant, localpart: string) {
    if (checkLocalpart(localpart) !== localpart) {
      mismatch('invalid membership account');
    }
    const context = grant.body.transcript.body.context;
    const [row] = await conn.query(
      'SELECT state,grant_json FROM facade_pairings WHERE id=? AND side=?',
      [context.id, this.node ? 'facade' : 'home'],
    );
    if (row?.state !== 'paired' || row.grant_json !== canonicalJson(grant)) {
      mismatch('membership exchange grant changed');
    }
    const scope = 'auth:@' + localpart + ':' + context.server;
    const selected = this.node
      ? await conn.query(
        'SELECT 1 FROM facade_scopes WHERE incarnation=? AND scope=? AND ready=1',
        [context.id, scope],
      )
      : await conn.query(
        'SELECT 1 FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
        [context.node, context.id, scope],
      );
    if (!selected.length) mismatch('membership account not selected');
  }

  /** Only committed immutable source facts are signed. A mutable display scan
   * could erase an accepted invite/rejection before the link ever saw it. */
  async export(localpart: string, pairing?: string): Promise<LinkRecord[]> {
    const grant = await this.binding(pairing),
      context = grant.body.transcript.body.context;
    const server = await this.store.server(), unchanged = signingFence(server);
    const control = await server.tx(async (conn) => {
      await this.selected(conn, grant, localpart);
      const [row] = await conn.query(
        'SELECT c.signed_json FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision WHERE a.pairing=?',
        [context.id],
      );
      if (!row) {
        throw new LinkError(
          'LINK_UNAVAILABLE',
          'membership export awaits ownership control',
          503,
        );
      }
      return JSON.parse(String(row.signed_json)).body as OwnerControl;
    });
    const source = control.nodes.find((n) =>
      n.node === (this.node?.node ?? 'home')
    );
    if (!source) mismatch('membership source unavailable');
    const binding: DomainBinding = {
      server: context.server,
      pairing: context.id,
      grantRevision: grant.body.revision,
      ownerRevision: control.revision,
      localpart,
      source: source.node,
      incarnation: source.incarnation,
    };
    const peer = this.node ? 'home' : context.node;
    const scope = 'membership-export:' + canonicalJson(binding);
    const operations = await server.tx(async (conn) => {
      unchanged();
      await this.selected(conn, grant, localpart);
      await requireDomainControl(conn, binding);
      const [exported] = await conn.query(
        'SELECT source_cut FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
        [peer, context.id, scope],
      );
      const after = Number(exported?.source_cut ?? 0);
      return await membershipOperations(
        conn,
        '@' + localpart + ':' + context.server,
        {
          source: source.node,
          incarnation: source.incarnation,
          sequence: after,
        },
      );
    });
    const records: LinkRecord[] = [];
    for (const operation of operations) {
      const view: MembershipView = {
        ...binding,
        kind: 'membership-operation',
        operation,
      };
      const signed = {
        body: view,
        signature: await (this.node?.signer() ?? this.tenant.signer()).sign(
          canonicalJson(view),
        ),
      };
      const record = await server.tx(async (conn) => {
        unchanged();
        await this.selected(conn, grant, localpart);
        await requireDomainControl(conn, view);
        const [current] = await conn.query(
          'SELECT source_cut FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
          [peer, context.id, scope],
        );
        if (Number(current?.source_cut ?? 0) >= operation.sequence) return null;
        const record = await appendRecord(conn, peer, {
          source: view.source,
          incarnation: this.node ? view.incarnation : context.id,
          stream: 'membership:@' + localpart + ':' + view.server,
          type: 'membership-operation',
          version: 1,
          operationId: 'membership:' +
            createHash('sha256').update(canonicalJson([
              view.pairing,
              view.grantRevision,
              view.ownerRevision,
              operation.operationId,
            ])).digest('hex'),
          payload: signed,
        });
        await conn.execute(
          'INSERT INTO facade_exports(peer,incarnation,scope,source_cut) VALUES(?,?,?,?) ON CONFLICT(peer,incarnation,scope) DO UPDATE SET source_cut=excluded.source_cut',
          [peer, context.id, scope, operation.sequence],
        );
        unchanged();
        return record;
      });
      if (record) records.push(record);
    }
    return records;
  }
}
