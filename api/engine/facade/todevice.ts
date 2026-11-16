// Signed semantic to-device exchange. The receiving tenant owns expansion,
// inbox positions and ACKs; the journal carries only immutable owner facts.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import { decodeToDevice } from '#engine/federation/todevice.ts';
import { domainOf, localpartOf } from '#engine/ids.ts';
import {
  importPublicKeyFromRaw,
  matrixBase64,
} from '#engine/signing-primitives.js';
import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import {
  captureIngressToDevice,
  captureToDeviceOperations,
  completeIngressToDevice,
  importToDeviceOperation,
  type ToDeviceIngressReceipt,
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
import { receiveMessages } from '#engine/tenant/todevice.ts';

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

  /** Original ingress and semantic source intents meet at the existing tenant
   * owner. The server child can be retried after this commit without recapture. */
  async ingress(
    origin: string,
    raw: unknown,
    receipt?: ToDeviceIngressReceipt,
    pairing?: string,
  ) {
    const input = decodeToDevice(origin, this.tenant.serverName, raw);
    const grant = await this.binding(pairing),
      context = grant.body.transcript.body.context;
    const server = await this.store.server(), unchanged = signingFence(server);
    const accounts = [
      ...new Set(
        input.messages.filter((m) => domainOf(m.user) === context.server)
          .map((m) => localpartOf(m.user)),
      ),
    ];
    const bindings: DomainBinding[] = [];
    await server.tx(async (conn) => {
      const [row] = await conn.query(
        'SELECT c.signed_json FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision WHERE a.pairing=?',
        [context.id],
      );
      if (!row) {
        throw new LinkError(
          'LINK_UNAVAILABLE',
          'ingress awaits ownership control',
          503,
        );
      }
      const control = JSON.parse(String(row.signed_json)).body as OwnerControl;
      const source = control.nodes.find((n) =>
        n.node === (this.node?.node ?? 'home')
      );
      if (!source) mismatch('ingress source unavailable');
      for (const localpart of accounts) {
        await this.selected(conn, grant, localpart);
        const view: DomainBinding = {
          server: context.server,
          pairing: context.id,
          grantRevision: grant.body.revision,
          ownerRevision: control.revision,
          localpart,
          source: source.node,
          incarnation: source.incarnation,
        };
        await requireDomainControl(conn, view);
        bindings.push(view);
      }
    });
    const { result, pending, changed } =
      await (await this.store.tenant(context.server)).tx(async (conn) => {
        unchanged();
        for (const view of bindings) await this.tenantSelected(conn, view);
        const before = await syncStreamHeads(conn);
        const [beforeOperation] = await conn.query(
          'SELECT operation_id FROM to_device_operations ORDER BY rowid DESC LIMIT 1',
        );
        if (receipt) {
          await completeIngressToDevice(
            conn,
            origin,
            input.id,
            input.sender,
            input.type,
            context.server,
            input.messages,
            receipt,
          );
        } else {
          const [legacy] = await conn.query(
            "SELECT 1 FROM to_device_admissions WHERE kind='federation' AND origin=? AND message_id=? AND policy='legacy'",
            [origin, input.id],
          );
          if (!legacy) {
            await receiveMessages(
              conn,
              origin,
              input.id,
              input.sender,
              input.type,
              context.server,
              input.messages,
              config().e2ee,
            );
          }
        }
        const result = receipt ??
          await captureIngressToDevice(
            conn,
            origin,
            input.id,
            input.sender,
            input.type,
            context.server,
            input.messages,
          );
        const pending = await pendingTenantProjection(conn);
        const inboxChanged =
          (await syncStreamHeads(conn)).inbox !== before.inbox;
        const [afterOperation] = await conn.query(
          'SELECT operation_id FROM to_device_operations ORDER BY rowid DESC LIMIT 1',
        );
        const changed = inboxChanged ||
          beforeOperation?.operation_id !== afterOperation?.operation_id;
        unchanged();
        return { result, pending, changed };
      });
    await tenantChangesCommitted(
      this.store,
      context.server,
      pending,
      changed,
      receipt ? 'replica' : 'local',
    );
    return result;
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
    const peer = this.node ? 'home' : context.node;
    // This is a source-operation cut, not an inbox or journal position. A
    // different grant/control/account/source gets an independent replay scope.
    const scope = 'to-device-export:' + canonicalJson(binding);
    const [exported] = await server.query(
      'SELECT source_cut FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
      [peer, context.id, scope],
    );
    const after = exported ? Number(exported.source_cut) : 0;
    const { operations, pending, inboxChanged } =
      await (await this.store.tenant(binding.server)).tx(async (conn) => {
        unchanged();
        await this.tenantSelected(conn, binding);
        const before = await syncStreamHeads(conn);
        const operations = await captureToDeviceOperations(
          conn,
          localpart,
          after,
        );
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
      const record = await server.tx(async (conn) => {
        await this.selected(conn, grant, localpart);
        await requireDomainControl(conn, view);
        const [current] = await conn.query(
          'SELECT source_cut FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
          [peer, context.id, scope],
        );
        if (current && Number(current.source_cut) >= operation.sequence) {
          return null;
        }
        const record = await appendRecord(conn, peer, {
          source: view.source,
          incarnation: this.node ? view.incarnation : context.id,
          stream: streamName(localpart, view.server),
          type: 'to-device',
          version: 1,
          operationId: operationId(view),
          payload: signed,
        });
        // Append and source-cut advancement cannot be separated by a crash.
        await conn.execute(
          'INSERT INTO facade_exports(peer,incarnation,scope,source_cut) VALUES(?,?,?,?) ON CONFLICT(peer,incarnation,scope) DO UPDATE SET source_cut=excluded.source_cut',
          [peer, context.id, scope, operation.sequence],
        );
        return record;
      });
      if (record) records.push(record);
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
