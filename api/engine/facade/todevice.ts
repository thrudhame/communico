// Signed semantic to-device exchange. The receiving tenant owns expansion,
// inbox positions and ACKs; the journal carries only immutable owner facts.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import {
  importPublicKeyFromRaw,
  matrixBase64,
} from '#engine/signing-primitives.js';
import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import {
  captureToDeviceOperations,
  importToDeviceOperation,
  type ToDeviceOperation,
} from '#engine/tenant/todevice-routing.ts';
import {
  linkApplication,
  retainLinkApplication,
} from '#engine/tenant/link-applications.ts';
import {
  pendingTenantProjection,
  tenantChangesCommitted,
} from '#engine/tenant/hooks.ts';
import { checkLocalpart } from '#engine/tenant/users.ts';
import { syncStreamHeads } from '#engine/tenant/streams.ts';
import { type DomainBinding, requireDomainControl } from './domain-control.ts';
import type { NodeIdentity } from './identity.ts';
import { appendRecord, type Journal } from './journal.ts';
import type { OwnerControl } from './ownership.ts';
import type { Grant, Pairings } from './pairing.ts';
import { integer, LinkError, object, type Stream, text } from './protocol.ts';
import { signingFence } from './signing-authority.ts';

type ToDeviceView = DomainBinding & {
  kind: 'to-device';
  operation: ToDeviceOperation;
};

function mismatch(message: string): never {
  throw new LinkError('LINK_IDENTITY_MISMATCH', message, 403);
}

function viewOf(raw: unknown): ToDeviceView {
  const row = object(raw), localpart = text(row.localpart);
  const view: ToDeviceView = {
    kind: 'to-device',
    server: text(row.server),
    pairing: text(row.pairing),
    grantRevision: integer(row.grantRevision, 1),
    ownerRevision: integer(row.ownerRevision, 1),
    localpart,
    source: text(row.source),
    incarnation: text(row.incarnation),
    operation: object(row.operation) as ToDeviceOperation,
  };
  if (
    checkLocalpart(localpart) !== localpart ||
    canonicalJson(view) !== canonicalJson(raw) ||
    view.operation.localpart !== localpart ||
    view.operation.source !== view.source ||
    view.operation.incarnation !== view.incarnation
  ) mismatch('to-device operation differs from signed source or account');
  return view;
}

function operationId(view: ToDeviceView) {
  return 'to-device:' + createHash('sha256').update(canonicalJson([
    view.pairing,
    view.grantRevision,
    view.ownerRevision,
    view.operation.operationId,
  ])).digest('hex');
}

function streamName(localpart: string, server: string) {
  return 'to-device:@' + localpart + ':' + server;
}

export function isToDeviceStream(stream: Stream): boolean {
  return stream.stream.startsWith('to-device:@');
}

export class ToDeviceOperations {
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
        mismatch('wrong to-device pairing');
      }
    } else {
      if (!pairing) mismatch('home to-device exchange requires pairing');
      const connection = await this.pairings.connection(pairing);
      if (connection.state !== 'paired' || !connection.grant) {
        mismatch('to-device exchange requires paired home');
      }
      grant = connection.grant;
    }
    const context = grant.body.transcript.body.context;
    if (
      context.server !== this.tenant.serverName || (this.node &&
        (context.node !== this.node.node ||
          grant.body.transcript.body.incarnation !== this.node.incarnation))
    ) {
      mismatch('to-device exchange differs from enrolled node');
    }
    return grant;
  }

  private async selected(conn: Conn, grant: Grant, localpart: string) {
    if (checkLocalpart(localpart) !== localpart) {
      mismatch('invalid to-device account');
    }
    const context = grant.body.transcript.body.context;
    const [row] = await conn.query(
      'SELECT state,grant_json FROM facade_pairings WHERE id=? AND side=?',
      [context.id, this.node ? 'facade' : 'home'],
    );
    if (row?.state !== 'paired' || row.grant_json !== canonicalJson(grant)) {
      mismatch('to-device exchange grant changed');
    }
    if (
      !this.node && !(await conn.query(
        'SELECT 1 FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
        [context.node, context.id, 'auth:@' + localpart + ':' + context.server],
      )).length
    ) {
      mismatch('to-device account not selected');
    }
  }

  private async tenantSelected(conn: Conn, view: DomainBinding) {
    await requireDomainControl(conn, view);
    if (!this.node) return;
    const [row] = await conn.query(
      'SELECT pairing,grant_revision FROM account_auth_snapshots WHERE localpart=?',
      [view.localpart],
    );
    if (
      row?.pairing !== view.pairing ||
      Number(row.grant_revision) !== view.grantRevision
    ) mismatch('to-device account not selected');
  }

  async export(localpart: string, pairing?: string) {
    const grant = await this.binding(pairing),
      context = grant.body.transcript.body.context;
    const server = await this.store.server();
    const unchanged = signingFence(server);
    const control = await server.tx(async (conn) => {
      await this.selected(conn, grant, localpart);
      const [row] = await conn.query(
        'SELECT c.signed_json FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision WHERE a.pairing=?',
        [context.id],
      );
      if (!row) {
        throw new LinkError(
          'LINK_UNAVAILABLE',
          'to-device export awaits ownership control',
          503,
        );
      }
      return JSON.parse(String(row.signed_json)).body as OwnerControl;
    });
    const source = control.nodes.find((n) =>
      n.node === (this.node?.node ?? 'home')
    );
    if (!source) mismatch('to-device source unavailable');
    const binding: DomainBinding = {
      server: context.server,
      pairing: context.id,
      grantRevision: grant.body.revision,
      ownerRevision: control.revision,
      localpart,
      source: source.node,
      incarnation: source.incarnation,
    };
    const { operations, pending, inboxChanged } =
      await (await this.store.tenant(binding.server)).tx(async (conn) => {
        unchanged();
        await this.tenantSelected(conn, binding);
        const before = await syncStreamHeads(conn);
        const operations = await captureToDeviceOperations(conn, localpart);
        const pending = await pendingTenantProjection(conn);
        const inboxChanged =
          (await syncStreamHeads(conn)).inbox !== before.inbox;
        unchanged();
        return { operations, pending, inboxChanged };
      });
    // Capture can discharge an already-admitted selector as its scope arrives.
    await tenantChangesCommitted(
      this.store,
      binding.server,
      pending,
      inboxChanged,
      'replica',
    );
    const records = [];
    for (const operation of operations) {
      const view = viewOf({ ...binding, kind: 'to-device', operation });
      const signed = {
        body: view,
        signature: await (this.node?.signer() ?? this.tenant.signer()).sign(
          canonicalJson(view),
        ),
      };
      records.push(
        await server.tx(async (conn) => {
          await this.selected(conn, grant, localpart);
          await requireDomainControl(conn, view);
          return await appendRecord(conn, this.node ? 'home' : context.node, {
            source: view.source,
            incarnation: this.node ? view.incarnation : context.id,
            stream: streamName(localpart, view.server),
            type: 'to-device',
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
    if (!this.node && !pairing) {
      mismatch('home to-device exchange requires pairing');
    }
    const peer = this.node ? 'home' : stream.source;
    const record = await journal.next(peer, stream);
    if (!record) return false;
    if (record.type !== 'to-device' || record.version !== 1) {
      throw new LinkError(
        'LINK_CAPABILITY_MISMATCH',
        'not to-device operation',
      );
    }
    const signed = object(record.payload), view = viewOf(signed.body);
    if (
      view.server !== this.tenant.serverName ||
      (!this.node && view.pairing !== pairing)
    ) mismatch('to-device completion differs from local scope');
    const tenant = await this.store.tenant(this.tenant.serverName);
    const { prior, pending } = await tenant.tx(async (conn) => ({
      prior: await linkApplication(conn, peer, record),
      pending: await pendingTenantProjection(conn),
    }));
    if (prior) {
      const { inboxChanged, ...result } = object(prior.result);
      await tenantChangesCommitted(
        this.store,
        this.tenant.serverName,
        pending,
        inboxChanged === true,
        'replica',
      );
      await journal.complete(peer, stream, record, result);
      return true;
    }
    const server = await this.store.server(), unchanged = signingFence(server);
    const grant = await this.binding(pairing),
      context = grant.body.transcript.body.context;
    if (
      view.server !== context.server || view.pairing !== context.id ||
      view.grantRevision !== grant.body.revision ||
      view.source !== peer || peer !== (this.node ? 'home' : context.node) ||
      record.source !== peer ||
      record.incarnation !==
        (this.node ? context.id : grant.body.transcript.body.incarnation) ||
      record.stream !== streamName(view.localpart, view.server) ||
      record.operationId !== operationId(view)
    ) {
      mismatch('to-device record differs from enrolled source or scope');
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
    } catch { /* Malformed signatures never grant inbox authority. */ }
    if (!valid) mismatch('invalid to-device operation signature');
    await server.tx(async (conn) => {
      await this.selected(conn, grant, view.localpart);
      await requireDomainControl(conn, view);
    });
    const { result, projectionRevision, inboxChanged } = await tenant.tx(
      async (conn) => {
        unchanged();
        await this.tenantSelected(conn, view);
        const before = await syncStreamHeads(conn);
        await importToDeviceOperation(conn, view.operation, view, view.server);
        const result = { operationId: view.operation.operationId };
        const inboxChanged =
          (await syncStreamHeads(conn)).inbox !== before.inbox;
        await retainLinkApplication(conn, peer, record, {
          ...result,
          inboxChanged,
        });
        const projectionRevision = await pendingTenantProjection(conn);
        // Revocation before this admission cut rolls back fact, inbox and receipt.
        // A successful commit is immutable admitted work even across retirement.
        unchanged();
        return { result, projectionRevision, inboxChanged };
      },
    );
    await tenantChangesCommitted(
      this.store,
      this.tenant.serverName,
      projectionRevision,
      inboxChanged,
      'replica',
    );
    await journal.complete(peer, stream, record, result);
    return true;
  }
}
