// Enrolled semantic exchange for current device owners. Public facts remain
// tenant-owned; the journal acknowledges only their durable owner application.
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
  captureDeviceOperations,
  type DeviceOperation,
} from '#engine/tenant/device-source.ts';
import { importDeviceOperation } from '#engine/tenant/device-operations.ts';
import { checkLocalpart } from '#engine/tenant/users.ts';
import { type DomainBinding, requireDomainControl } from './domain-control.ts';
import type { NodeIdentity } from './identity.ts';
import { appendRecord, type Journal } from './journal.ts';
import type { OwnerControl } from './ownership.ts';
import type { Grant, Pairings } from './pairing.ts';
import { integer, LinkError, object, type Stream, text } from './protocol.ts';

export type DeviceView = DomainBinding & {
  kind: 'device-operation';
  operation: DeviceOperation;
};

function mismatch(message: string): never {
  throw new LinkError('LINK_IDENTITY_MISMATCH', message, 403);
}

function viewOf(raw: unknown): DeviceView {
  const row = object(raw), operation = object(row.operation);
  const localpart = text(row.localpart);
  const view: DeviceView = {
    kind: 'device-operation',
    server: text(row.server),
    pairing: text(row.pairing),
    grantRevision: integer(row.grantRevision, 1),
    ownerRevision: integer(row.ownerRevision, 1),
    localpart,
    source: text(row.source),
    incarnation: text(row.incarnation),
    operation: operation as DeviceOperation,
  };
  if (
    checkLocalpart(localpart) !== localpart ||
    canonicalJson(view) !== canonicalJson(raw) ||
    operation.localpart !== localpart || operation.source !== view.source ||
    operation.incarnation !== view.incarnation
  ) mismatch('device operation differs from signed source or account');
  return view;
}

function operationId(view: DeviceView) {
  return 'device:' + createHash('sha256').update(canonicalJson([
    view.pairing,
    view.grantRevision,
    view.ownerRevision,
    view.operation.operationId,
  ])).digest('hex');
}

function streamName(localpart: string, server: string) {
  return 'devices:@' + localpart + ':' + server;
}

export class DeviceOperations {
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
        mismatch('wrong device pairing');
      }
    } else {
      if (!pairing) mismatch('home device exchange requires pairing');
      const connection = await this.pairings.connection(pairing);
      if (connection.state !== 'paired' || !connection.grant) {
        mismatch('device exchange requires paired home');
      }
      grant = connection.grant;
    }
    const context = grant.body.transcript.body.context;
    if (
      context.server !== this.tenant.serverName || (this.node &&
        (context.node !== this.node.node ||
          grant.body.transcript.body.incarnation !== this.node.incarnation))
    ) mismatch('device exchange differs from enrolled node');
    return grant;
  }

  private async selected(conn: Conn, grant: Grant, localpart: string) {
    if (checkLocalpart(localpart) !== localpart) {
      mismatch('invalid device account');
    }
    const context = grant.body.transcript.body.context;
    const [row] = await conn.query(
      'SELECT state,grant_json FROM facade_pairings WHERE id=? AND side=?',
      [context.id, this.node ? 'facade' : 'home'],
    );
    if (row?.state !== 'paired' || row.grant_json !== canonicalJson(grant)) {
      mismatch('device exchange grant changed');
    }
    if (
      !this.node && !(await conn.query(
        'SELECT 1 FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
        [context.node, context.id, 'auth:@' + localpart + ':' + context.server],
      )).length
    ) mismatch('device account not selected');
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
    ) {
      mismatch('device account not selected');
    }
  }

  /** Export original local owner intent only. Full bootstrap/history and public
   * reader activation are separate contracts, not implied by this suffix. */
  async export(localpart: string, pairing?: string) {
    const grant = await this.binding(pairing),
      context = grant.body.transcript.body.context;
    const server = await this.store.server();
    const control = await server.tx(async (conn) => {
      await this.selected(conn, grant, localpart);
      const [row] = await conn.query(
        'SELECT c.signed_json FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision WHERE a.pairing=?',
        [context.id],
      );
      if (!row) {
        throw new LinkError(
          'LINK_UNAVAILABLE',
          'device export awaits ownership control',
          503,
        );
      }
      return JSON.parse(String(row.signed_json)).body as OwnerControl;
    });
    const source = control.nodes.find((node) =>
      node.node === (this.node?.node ?? 'home')
    );
    if (!source) mismatch('device source unavailable');
    const binding: DomainBinding = {
      server: context.server,
      pairing: context.id,
      grantRevision: grant.body.revision,
      ownerRevision: control.revision,
      localpart,
      source: source.node,
      incarnation: source.incarnation,
    };
    const operations = await (await this.store.tenant(context.server)).tx(
      async (conn) => {
        await this.tenantSelected(conn, binding);
        return await captureDeviceOperations(conn, localpart);
      },
    );
    const records = [];
    for (const operation of operations) {
      const view = viewOf({ ...binding, kind: 'device-operation', operation });
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
            stream: streamName(localpart, context.server),
            type: 'device-operation',
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
    if (record.type !== 'device-operation' || record.version !== 1) {
      throw new LinkError('LINK_CAPABILITY_MISMATCH', 'not device operation');
    }
    const signed = object(record.payload), view = viewOf(signed.body);
    if (
      view.server !== context.server || view.pairing !== context.id ||
      view.grantRevision !== grant.body.revision || view.source !== peer ||
      record.source !== peer ||
      record.incarnation !==
        (this.node ? context.id : grant.body.transcript.body.incarnation) ||
      record.stream !== streamName(view.localpart, view.server) ||
      record.operationId !== operationId(view)
    ) mismatch('device record differs from enrolled source or scope');
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
    } catch { /* Malformed signatures carry no public device authority. */ }
    if (!valid) mismatch('invalid device operation signature');
    const check = async (conn: Conn) => {
      await this.selected(conn, grant, view.localpart);
      await requireDomainControl(conn, view);
    };
    await (await this.store.server()).tx(check);
    await (await this.store.tenant(context.server)).tx(async (conn) => {
      await this.tenantSelected(conn, view);
      await importDeviceOperation(conn, view.operation, view);
    });
    // A crash before this ACK replays only the immutable tenant fact. It cannot
    // reauthor the operation, mint sessions or allocate a consuming key pool.
    return await journal.apply(peer, stream, async (conn, current) => {
      await check(conn);
      if (current.hash !== record.hash) {
        throw new LinkError('LINK_DIVERGED', 'device application raced');
      }
      return { operationId: view.operation.operationId };
    });
  }
}
