// Signed semantic intents over the existing enrolled journal. Each value is
// interpreted and materialized by its original tenant/server owner, not SQL
// replication. Imported operations never acquire this node's authorship.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import {
  importPublicKeyFromRaw,
  matrixBase64,
} from '#engine/signing-primitives.js';
import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { checkLocalpart } from '#engine/tenant/users.ts';
import {
  receiptOperationMark,
  receiptOperations,
} from '#engine/server/receipt-operations.ts';
import { importReceiptOperation } from '#engine/server/ephemeral.ts';
import type { NodeIdentity } from './identity.ts';
import { appendRecord, type Journal } from './journal.ts';
import type { OwnerControl } from './ownership.ts';
import type { Grant, Pairings } from './pairing.ts';
import { integer, LinkError, object, type Stream, text } from './protocol.ts';
import type { RegisterOperation } from './registers.ts';
import { type DomainBinding, requireDomainControl } from './domain-control.ts';

export type DomainOperation = DomainBinding & {
  kind: 'domain-operation';
  operation: RegisterOperation;
};

function mismatch(message: string): never {
  throw new LinkError('LINK_IDENTITY_MISMATCH', message, 403);
}
function streamName(localpart: string, server: string) {
  return 'domain:@' + localpart + ':' + server;
}
function operationId(view: DomainOperation) {
  return 'domain:' + createHash('sha256').update(canonicalJson([
    view.pairing,
    view.grantRevision,
    view.ownerRevision,
    view.operation.operationId,
  ])).digest('hex');
}

function viewOf(raw: unknown): DomainOperation {
  const row = object(raw), operation = object(row.operation);
  const localpart = text(row.localpart);
  if (
    row.kind !== 'domain-operation' || checkLocalpart(localpart) !== localpart
  ) {
    mismatch('invalid domain account');
  }
  const view: DomainOperation = {
    kind: 'domain-operation',
    server: text(row.server),
    pairing: text(row.pairing),
    grantRevision: integer(row.grantRevision, 1),
    ownerRevision: integer(row.ownerRevision, 1),
    localpart,
    source: text(row.source),
    incarnation: text(row.incarnation),
    operation: operation as RegisterOperation,
  };
  if (
    canonicalJson(view) !== canonicalJson(raw) ||
    operation.source !== view.source ||
    operation.incarnation !== view.incarnation
  ) {
    mismatch('domain operation differs from signed source');
  }
  // Account selection applies to the semantic key, not an untrusted envelope
  // label. Leaf owners still validate the complete operation/value contract.
  if (operation.kind === 'receipt') {
    if (
      receiptOperationMark(operation as RegisterOperation & { kind: 'receipt' })
        .userId !==
        '@' + localpart + ':' + view.server
    ) mismatch('receipt account not selected');
  } else {
    let key: unknown;
    try {
      key = JSON.parse(text(operation.semanticKey));
    } catch {
      mismatch('invalid domain key');
    }
    const expected = operation.kind === 'tags'
      ? 'account-data'
      : operation.kind;
    if (
      !['account-data', 'profile', 'push-rules'].includes(String(expected)) ||
      !Array.isArray(key) || key[0] !== expected || key[1] !== localpart
    ) {
      mismatch('domain account not selected');
    }
  }
  return view;
}

/** Home passes a pairing ID, facade passes its enrolled node identity. This
 * adapter exports only original local source intent, never a replica echo. */
export class DomainOperations {
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
        mismatch('wrong domain pairing');
      }
    } else {
      if (!pairing) mismatch('home domain exchange requires pairing');
      const connection = await this.pairings.connection(pairing);
      if (connection.state !== 'paired' || !connection.grant) {
        mismatch('domain exchange requires paired home');
      }
      grant = connection.grant;
    }
    const context = grant.body.transcript.body.context;
    if (
      context.server !== this.tenant.serverName || (this.node &&
        (context.node !== this.node.node ||
          grant.body.transcript.body.incarnation !== this.node.incarnation))
    ) {
      mismatch('domain exchange differs from enrolled node');
    }
    return grant;
  }

  private async selected(conn: Conn, grant: Grant, localpart: string) {
    const context = grant.body.transcript.body.context;
    const [row] = await conn.query(
      'SELECT state,grant_json FROM facade_pairings WHERE id=? AND side=?',
      [context.id, this.node ? 'facade' : 'home'],
    );
    if (row?.state !== 'paired' || row.grant_json !== canonicalJson(grant)) {
      mismatch('domain exchange grant changed');
    }
    if (
      !this.node && !(await conn.query(
        'SELECT 1 FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
        [context.node, context.id, 'auth:@' + localpart + ':' + context.server],
      )).length
    ) mismatch('domain account not selected');
  }

  private async tenantSelected(localpart: string, grant: Grant) {
    if (!this.node) return;
    const [row] = await (await this.store.tenant(this.tenant.serverName)).query(
      'SELECT pairing,grant_revision FROM account_auth_snapshots WHERE localpart=?',
      [localpart],
    );
    if (
      row?.pairing !== grant.body.transcript.body.context.id ||
      Number(row.grant_revision) !== grant.body.revision
    ) {
      mismatch('domain account not selected');
    }
  }

  async export(localpart: string, pairing?: string) {
    const grant = await this.binding(pairing),
      context = grant.body.transcript.body.context;
    await this.tenantSelected(localpart, grant);
    const db = await this.store.server();
    const control = await db.tx(async (conn) => {
      await this.selected(conn, grant, localpart);
      const [row] = await conn.query(
        'SELECT c.signed_json FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision WHERE a.pairing=?',
        [context.id],
      );
      if (!row) {
        throw new LinkError(
          'LINK_UNAVAILABLE',
          'domain export awaits ownership control',
          503,
        );
      }
      return JSON.parse(String(row.signed_json)).body as OwnerControl;
    });
    const source = control.nodes.find((node) =>
      node.node === (this.node?.node ?? 'home')
    );
    if (!source) mismatch('domain source unavailable');
    const binding: DomainBinding = {
      server: context.server,
      pairing: context.id,
      grantRevision: grant.body.revision,
      ownerRevision: control.revision,
      localpart,
      source: source.node,
      incarnation: source.incarnation,
    };
    const operations = await this.tenant.tx(async (tx) => {
      await tx.domains.authorize(
        binding,
        this.node
          ? { pairing: context.id, revision: grant.body.revision }
          : undefined,
      );
      return [
        ...await tx.accountData.operations(localpart),
        ...await tx.profiles.operations(localpart),
        ...await tx.pushRules.operations(localpart),
      ];
    });
    operations.push(
      ...await db.tx((conn) =>
        receiptOperations(conn, '@' + localpart + ':' + context.server)
      ),
    );
    const records = [];
    for (const operation of operations) {
      if (
        operation.source !== source.node ||
        operation.incarnation !== source.incarnation
      ) continue;
      const view = viewOf({
        kind: 'domain-operation',
        server: context.server,
        pairing: context.id,
        grantRevision: grant.body.revision,
        ownerRevision: control.revision,
        localpart,
        source: source.node,
        incarnation: source.incarnation,
        operation,
      });
      const signed = {
        body: view,
        signature: await (this.node?.signer() ?? this.tenant.signer()).sign(
          canonicalJson(view),
        ),
      };
      records.push(
        await db.tx(async (conn) => {
          await this.selected(conn, grant, localpart);
          await requireDomainControl(conn, view);
          return await appendRecord(conn, this.node ? 'home' : context.node, {
            source: source.node,
            incarnation: this.node ? source.incarnation : context.id,
            stream: streamName(localpart, context.server),
            type: 'domain-operation',
            version: 1,
            operationId: operationId(view),
            payload: signed,
          });
        }),
      );
    }
    return records;
  }

  async apply(
    journal: Journal,
    stream: Stream,
    pairing?: string,
  ): Promise<boolean> {
    const grant = await this.binding(pairing),
      context = grant.body.transcript.body.context;
    const peer = this.node ? 'home' : context.node;
    const record = await journal.next(peer, stream);
    if (!record) return false;
    if (record.type !== 'domain-operation' || record.version !== 1) {
      throw new LinkError('LINK_CAPABILITY_MISMATCH', 'not domain operation');
    }
    const signed = object(record.payload), view = viewOf(signed.body);
    const sender = this.node ? 'home' : context.node;
    if (
      view.server !== context.server || view.pairing !== context.id ||
      view.grantRevision !== grant.body.revision || view.source !== sender ||
      record.source !== sender ||
      record.incarnation !==
        (this.node ? context.id : grant.body.transcript.body.incarnation) ||
      record.stream !== streamName(view.localpart, view.server) ||
      record.operationId !== operationId(view)
    ) {
      mismatch('domain record differs from enrolled source or scope');
    }
    let valid = false;
    try {
      valid = await crypto.subtle.verify(
        'Ed25519',
        await importPublicKeyFromRaw(matrixBase64(
          this.node
            ? context.home.publicKey
            : grant.body.transcript.body.key.publicKey,
          32,
        )),
        matrixBase64(text(signed.signature), 64),
        new TextEncoder().encode(canonicalJson(view)),
      );
    } catch { /* A malformed signature grants no semantic authority. */ }
    if (!valid) mismatch('invalid domain operation signature');
    await this.tenantSelected(view.localpart, grant);
    const check = async (conn: Conn) => {
      await this.selected(conn, grant, view.localpart);
      await requireDomainControl(conn, view);
    };
    await (await this.store.server()).tx(check);
    if (view.operation.kind === 'receipt') {
      await importReceiptOperation(
        await this.store.server(),
        view.operation as RegisterOperation & { kind: 'receipt' },
        {
          source: view.source,
          incarnation: view.incarnation,
          userId: '@' + view.localpart + ':' + view.server,
        },
        check,
      );
    } else {
      await this.tenant.tx(async (tx) => {
        await tx.domains.authorize(
          view,
          this.node
            ? { pairing: context.id, revision: grant.body.revision }
            : undefined,
        );
        if (view.operation.kind === 'profile') {
          await tx.profiles.import(view.operation);
        } else if (view.operation.kind === 'push-rules') {
          await tx.pushRules.import(view.operation);
        } else await tx.accountData.import(view.operation);
      });
    }
    // Cross-file crash replay is safe: the semantic owner deduplicates before
    // any new local stream news, and only then does the journal applied cut move.
    return await journal.apply(peer, stream, async (conn, current) => {
      await check(conn);
      if (current.hash !== record.hash) {
        throw new LinkError('LINK_DIVERGED', 'domain application raced');
      }
      return { operationId: view.operation.operationId };
    });
  }
}
