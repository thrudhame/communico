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
  captureReceiptOperations,
  receiptOperationMark,
  receiptOperations,
} from '#engine/server/receipt-operations.ts';
import { captureAccountDataOperations } from '#engine/tenant/accountdata.ts';
import { captureProfileOperations } from '#engine/tenant/profiles.ts';
import { capturePushRuleOperations } from '#engine/tenant/pushrules.ts';
import { captureFilterOperations } from '#engine/tenant/filters.ts';
import { captureOpenIdOperations } from '#engine/tenant/openid.ts';
import { captureBackupOperations } from '#engine/tenant/key-backup.ts';
import {
  capturePusherOperations,
  pusherChoiceOperations,
  requirePusherChoices,
} from '#engine/tenant/pushers.ts';
import {
  captureReportOperations,
  importReportOperation,
  reportOperations,
} from '#engine/server/reports.ts';
import { importReceiptOperation } from '#engine/server/ephemeral.ts';
import {
  captureNotificationOperations,
  notificationOperations,
} from '#engine/server/notification-operations.ts';
import { receiveNotificationOperation } from '#engine/server/notifications.ts';
import {
  captureForgetOperations,
  forgetOperations,
  importForgetOperation,
  installForgetInventory,
} from '#engine/server/membership.ts';
import type { NodeIdentity } from './identity.ts';
import { appendRecord, type Journal } from './journal.ts';
import type { OwnerControl } from './ownership.ts';
import type { Grant, Pairings } from './pairing.ts';
import { integer, LinkError, object, type Stream, text } from './protocol.ts';
import { readRegister, type RegisterOperation } from './registers.ts';
import {
  type DomainBinding,
  type DomainHistory,
  DomainHistoryProof,
  requireDomainControl,
} from './domain-control.ts';

export type DomainOperation = DomainBinding & {
  kind: 'domain-operation';
  operation: RegisterOperation;
};
type Fact = { operationId: string; payloadHash: string };
export type DomainBootstrap = DomainBinding & {
  kind: 'domain-bootstrap';
  tenant: Fact[];
  receipts: Fact[];
  // Absent on older F2 writers: those bootstraps remain valid for their
  // original types, but cannot enable reads of an unproved filter inventory.
  filters?: Fact[];
  openid?: Fact[];
  backups?: Fact[];
  reports?: Fact[];
  forget?: Fact[];
  pushers?: Fact[];
  pusherChoices?: Fact[];
  notifications?: Fact[];
};

function facts(operations: Fact[]): Fact[] {
  return operations.map(({ operationId, payloadHash }) => ({
    operationId,
    payloadHash,
  }))
    .sort((a, b) =>
      a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0
    );
}

function bootstrapOf(raw: unknown): DomainBootstrap {
  const row = object(raw);
  const localpart = text(row.localpart);
  if (
    row.kind !== 'domain-bootstrap' || checkLocalpart(localpart) !== localpart
  ) mismatch('invalid domain bootstrap');
  const refs = (raw: unknown) => {
    if (!Array.isArray(raw)) {
      throw new LinkError('LINK_BAD_RECORD', 'invalid domain manifest', 400);
    }
    const result = raw.map((raw) => {
      const row = object(raw), payloadHash = text(row.payloadHash);
      if (!/^[a-f0-9]{64}$/.test(payloadHash)) {
        mismatch('invalid domain manifest hash');
      }
      return { operationId: text(row.operationId), payloadHash };
    });
    if (new Set(result.map((row) => row.operationId)).size !== result.length) {
      mismatch('duplicate domain manifest fact');
    }
    return facts(result);
  };
  const view: DomainBootstrap = {
    kind: 'domain-bootstrap',
    server: text(row.server),
    pairing: text(row.pairing),
    grantRevision: integer(row.grantRevision, 1),
    ownerRevision: integer(row.ownerRevision, 1),
    localpart,
    source: text(row.source),
    incarnation: text(row.incarnation),
    tenant: refs(row.tenant),
    receipts: refs(row.receipts),
    ...(row.filters !== undefined ? { filters: refs(row.filters) } : {}),
    ...(row.openid !== undefined ? { openid: refs(row.openid) } : {}),
    ...(row.backups !== undefined ? { backups: refs(row.backups) } : {}),
    ...(row.reports !== undefined ? { reports: refs(row.reports) } : {}),
    ...(row.forget !== undefined ? { forget: refs(row.forget) } : {}),
    ...(row.pushers !== undefined ? { pushers: refs(row.pushers) } : {}),
    ...(row.pusherChoices !== undefined
      ? { pusherChoices: refs(row.pusherChoices) }
      : {}),
    ...(row.notifications !== undefined
      ? { notifications: refs(row.notifications) }
      : {}),
  };
  if (canonicalJson(view) !== canonicalJson(raw) || view.source !== 'home') {
    mismatch('unexpected domain bootstrap material');
  }
  return view;
}

/** Presence is proved in each owning file. Register rows must also have their
 * authentic predecessor closure; a receipt may remain durably undisclosed while
 * receiver room evidence is missing, as its receipt owner explicitly permits. */
async function requireFacts(
  conn: Conn,
  view: DomainBootstrap,
  file:
    | 'tenant'
    | 'receipts'
    | 'filters'
    | 'openid'
    | 'backups'
    | 'reports'
    | 'forget'
    | 'pushers'
    | 'pusherChoices'
    | 'notifications',
) {
  const keys = new Set<string>();
  for (const fact of view[file] ?? []) {
    const [row] = await conn.query(
      'SELECT semantic_key,kind,payload_hash,payload_json FROM domain_operations WHERE operation_id=?',
      [fact.operationId],
    );
    if (!row) {
      throw new LinkError(
        'LINK_UNAVAILABLE',
        'domain bootstrap awaits retained facts',
        503,
      );
    }
    if (row.payload_hash !== fact.payloadHash) {
      throw new LinkError('LINK_DIVERGED', 'domain bootstrap fact changed');
    }
    if (file === 'receipts') {
      const mark = JSON.parse(String(row.payload_json));
      if (
        row.kind !== 'receipt' ||
        mark.userId !== '@' + view.localpart + ':' + view.server
      ) mismatch('bootstrap receipt account differs');
    } else {
      const key = JSON.parse(String(row.semantic_key));
      if (
        !Array.isArray(key) || key[1] !== view.localpart ||
        !(file === 'filters'
          ? ['filter']
          : file === 'openid'
          ? ['openid']
          : file === 'backups'
          ? ['backup']
          : file === 'reports'
          ? ['report', 'report-resolution']
          : file === 'forget'
          ? ['forget']
          : file === 'pushers'
          ? ['pusher']
          : file === 'pusherChoices'
          ? ['pusher-choice']
          : file === 'notifications'
          ? ['notification']
          : ['account-data', 'tags', 'profile', 'push-rules']).includes(
            String(row.kind),
          )
      ) mismatch('bootstrap tenant account differs');
      keys.add(String(row.semantic_key));
    }
  }
  const retained = new Set((view[file] ?? []).map((fact) => fact.operationId));
  for (const key of keys) {
    if (
      (await readRegister(conn, key)).pending.some((op) =>
        retained.has(op.operationId)
      )
    ) {
      throw new LinkError(
        'LINK_UNAVAILABLE',
        'domain bootstrap awaits causal history',
        503,
      );
    }
  }
}

function mismatch(message: string): never {
  throw new LinkError('LINK_IDENTITY_MISMATCH', message, 403);
}
function streamName(localpart: string, server: string) {
  return 'domain:@' + localpart + ':' + server;
}
function operationId(view: DomainOperation | DomainHistory | DomainBootstrap) {
  if (view.kind === 'domain-bootstrap') {
    return 'domain-bootstrap:' +
      createHash('sha256').update(canonicalJson(view)).digest('hex');
  }
  return (view.kind === 'domain-history' ? 'domain-history:' : 'domain:') +
    createHash('sha256').update(canonicalJson([
      view.pairing,
      view.grantRevision,
      view.ownerRevision,
      view.operation.operationId,
    ])).digest('hex');
}

function viewOf(raw: unknown): DomainOperation | DomainHistory {
  const row = object(raw), operation = object(row.operation);
  const localpart = text(row.localpart);
  if (
    !['domain-operation', 'domain-history'].includes(String(row.kind)) ||
    checkLocalpart(localpart) !== localpart
  ) {
    mismatch('invalid domain account');
  }
  const view: DomainOperation | DomainHistory = {
    kind: row.kind as 'domain-operation' | 'domain-history',
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
    (view.kind === 'domain-history'
      ? view.source !== 'home'
      : operation.source !== view.source ||
        operation.incarnation !== view.incarnation)
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
      ![
        'account-data',
        'profile',
        'push-rules',
        'filter',
        'openid',
        'backup',
        'report',
        'report-resolution',
        'forget',
        'pusher',
        'pusher-choice',
        'notification',
      ]
        .includes(
          String(expected),
        ) ||
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

  private async publish(
    view: DomainOperation | DomainHistory | DomainBootstrap,
    grant: Grant,
  ) {
    const context = grant.body.transcript.body.context;
    const signed = {
      body: view,
      signature: await (this.node?.signer() ?? this.tenant.signer()).sign(
        canonicalJson(view),
      ),
    };
    return await (await this.store.server()).tx(async (conn) => {
      await this.selected(conn, grant, view.localpart);
      await requireDomainControl(conn, view);
      return await appendRecord(conn, this.node ? 'home' : context.node, {
        source: view.source,
        incarnation: this.node ? view.incarnation : context.id,
        stream: streamName(view.localpart, context.server),
        type: 'domain-operation',
        version: 1,
        operationId: operationId(view),
        payload: signed,
      });
    });
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
        ...await tx.filters.operations(localpart),
        ...await tx.openid.operations(localpart),
        ...await tx.keyBackup.operations(localpart),
        ...await tx.pushers.operations(localpart),
        ...await tx.pushers.choices(localpart),
      ];
    });
    operations.push(
      ...await db.tx((conn) =>
        receiptOperations(conn, '@' + localpart + ':' + context.server)
      ),
      ...await db.tx((conn) =>
        reportOperations(conn, '@' + localpart + ':' + context.server)
      ),
      ...await db.tx((conn) =>
        forgetOperations(conn, '@' + localpart + ':' + context.server)
      ),
      ...await db.tx((conn) =>
        notificationOperations(conn, '@' + localpart + ':' + context.server)
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
      records.push(await this.publish(view, grant));
    }
    return records;
  }

  /** Pin explicit baseline facts in their original owner transactions, export
   * source operations, then publish a signed completeness declaration. Suffix
   * writes remain source intent and appear on this same independently drained
   * account stream; neither a copied F1 snapshot nor receipt news is a baseline. */
  async bootstrap(localpart: string, pairing: string) {
    if (this.node) mismatch('only home may declare domain bootstrap');
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
          'domain bootstrap awaits control',
          503,
        );
      }
      return JSON.parse(String(row.signed_json)).body as OwnerControl;
    });
    const source = control.nodes.find((node) => node.node === 'home');
    if (!source) mismatch('home domain source unavailable');
    const binding: DomainBinding = {
      server: context.server,
      pairing: context.id,
      grantRevision: grant.body.revision,
      ownerRevision: control.revision,
      localpart,
      source: source.node,
      incarnation: source.incarnation,
    };
    const tenantFacts = await (await this.store.tenant(context.server)).tx(
      async (conn) => {
        await requireDomainControl(conn, binding);
        const [user] = await conn.query(
          'SELECT deactivated FROM users WHERE localpart=?',
          [localpart],
        );
        if (!user) mismatch('domain account unavailable');
        if (user.deactivated === 1) return [];
        return [
          ...await captureAccountDataOperations(conn, localpart),
          ...await captureProfileOperations(conn, localpart),
          ...await capturePushRuleOperations(conn, localpart, context.server),
          ...await captureFilterOperations(conn, localpart),
          ...await captureOpenIdOperations(conn, localpart),
          ...await captureBackupOperations(conn, localpart),
          ...await capturePusherOperations(conn, localpart),
          ...await pusherChoiceOperations(conn, localpart),
        ];
      },
    );
    const receiptFacts = await server.tx(async (conn) => {
      await this.selected(conn, grant, localpart);
      await requireDomainControl(conn, binding);
      return await captureReceiptOperations(
        conn,
        '@' + localpart + ':' + context.server,
      );
    });
    const reportFacts = await server.tx(async (conn) => {
      await this.selected(conn, grant, localpart);
      await requireDomainControl(conn, binding);
      return await captureReportOperations(
        conn,
        '@' + localpart + ':' + context.server,
      );
    });
    // Legacy capture must precede export, otherwise the completeness declaration
    const forgetFacts = await server.tx(async (conn) => {
      await this.selected(conn, grant, localpart);
      await requireDomainControl(conn, binding);
      return await captureForgetOperations(
        conn,
        '@' + localpart + ':' + context.server,
      );
    });
    // Legacy capture must precede export, otherwise the completeness declaration
    // could overtake the source records it names.
    const notificationFacts = await server.tx(async (conn) => {
      await this.selected(conn, grant, localpart);
      await requireDomainControl(conn, binding);
      return await captureNotificationOperations(
        conn,
        '@' + localpart + ':' + context.server,
      );
    });
    const records = await this.export(localpart, pairing);
    // Ordinary export never echoes replica intent. Bootstrap separately attests
    // exactly the authentic history home retained, including a receiver's own
    // prior dots and prior incarnations. No dot, payload or context is rebased.
    for (
      const operation of [
        ...tenantFacts,
        ...receiptFacts,
        ...reportFacts,
        ...forgetFacts,
        ...notificationFacts,
      ]
    ) {
      if (
        operation.source === source.node &&
        operation.incarnation === source.incarnation
      ) continue;
      records.push(
        await this.publish(
          viewOf({
            ...binding,
            kind: 'domain-history',
            operation,
          }),
          grant,
        ),
      );
    }
    const body = bootstrapOf({
      ...binding,
      kind: 'domain-bootstrap',
      tenant: facts(
        tenantFacts.filter((op) =>
          !['filter', 'openid', 'backup', 'pusher', 'pusher-choice'].includes(
            op.kind,
          )
        ),
      ),
      receipts: facts(receiptFacts),
      filters: facts(tenantFacts.filter((op) => op.kind === 'filter')),
      openid: facts(tenantFacts.filter((op) => op.kind === 'openid')),
      backups: facts(tenantFacts.filter((op) => op.kind === 'backup')),
      reports: facts(reportFacts),
      forget: facts(forgetFacts),
      pushers: facts(tenantFacts.filter((op) => op.kind === 'pusher')),
      pusherChoices: facts(
        tenantFacts.filter((op) => op.kind === 'pusher-choice'),
      ),
      notifications: facts(notificationFacts),
    });
    records.push(await this.publish(body, grant));
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
    const signed = object(record.payload);
    const view = object(signed.body).kind === 'domain-bootstrap'
      ? bootstrapOf(signed.body)
      : viewOf(signed.body);
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
    if (view.kind === 'domain-history' && !this.node) {
      mismatch('only home may attest domain history');
    }
    await this.tenantSelected(view.localpart, grant);
    const check = async (conn: Conn) => {
      await this.selected(conn, grant, view.localpart);
      await requireDomainControl(conn, view);
    };
    await (await this.store.server()).tx(check);
    if (view.kind === 'domain-bootstrap') {
      if (!this.node) mismatch('facade cannot declare domain bootstrap');
      await (await this.store.tenant(view.server)).tx(async (conn) => {
        await requireDomainControl(conn, view);
        const [selected] = await conn.query(
          'SELECT pairing,grant_revision FROM account_auth_snapshots WHERE localpart=?',
          [view.localpart],
        );
        if (
          selected?.pairing !== view.pairing ||
          Number(selected.grant_revision) !== view.grantRevision
        ) mismatch('bootstrap account not selected');
        await requireFacts(conn, view, 'tenant');
        await requireFacts(conn, view, 'filters');
        await requireFacts(conn, view, 'openid');
        await requireFacts(conn, view, 'backups');
        await requireFacts(conn, view, 'pushers');
        await requireFacts(conn, view, 'pusherChoices');
        if (view.pusherChoices !== undefined) {
          await requirePusherChoices(conn, view.localpart);
        }
      });
      return await journal.apply(peer, stream, async (conn, current) => {
        await check(conn);
        if (current.hash !== record.hash) {
          throw new LinkError(
            'LINK_DIVERGED',
            'domain bootstrap application raced',
          );
        }
        await requireFacts(conn, view, 'receipts');
        await requireFacts(conn, view, 'reports');
        await requireFacts(conn, view, 'forget');
        await requireFacts(conn, view, 'notifications');
        await conn.execute(
          'INSERT INTO facade_scopes(incarnation,scope,source_cut,ready,pending_hash) VALUES(?,?,?,?,NULL) ON CONFLICT(incarnation,scope) DO UPDATE SET source_cut=excluded.source_cut,ready=excluded.ready,pending_hash=NULL',
          [
            view.pairing,
            'notifications:@' + view.localpart + ':' + view.server,
            record.sequence,
            view.notifications !== undefined ? 1 : 0,
          ],
        );
        if (view.forget !== undefined) {
          await installForgetInventory(
            conn,
            '@' + view.localpart + ':' + view.server,
            view.server,
          );
        }
        await conn.execute(
          'INSERT INTO facade_scopes(incarnation,scope,source_cut,ready,pending_hash) VALUES(?,?,?,?,NULL) ON CONFLICT(incarnation,scope) DO UPDATE SET source_cut=excluded.source_cut,ready=excluded.ready,pending_hash=NULL',
          [
            view.pairing,
            'forget:@' + view.localpart + ':' + view.server,
            record.sequence,
            view.forget !== undefined ? 1 : 0,
          ],
        );
        await conn.execute(
          'INSERT INTO facade_scopes(incarnation,scope,source_cut,ready,pending_hash) VALUES(?,?,?,1,NULL) ON CONFLICT(incarnation,scope) DO UPDATE SET source_cut=excluded.source_cut,ready=1,pending_hash=NULL',
          [view.pairing, record.stream, record.sequence],
        );
        await conn.execute(
          'INSERT INTO facade_scopes(incarnation,scope,source_cut,ready,pending_hash) VALUES(?,?,?,?,NULL) ON CONFLICT(incarnation,scope) DO UPDATE SET source_cut=excluded.source_cut,ready=excluded.ready,pending_hash=NULL',
          [
            view.pairing,
            'filters:@' + view.localpart + ':' + view.server,
            record.sequence,
            view.filters !== undefined ? 1 : 0,
          ],
        );
        await conn.execute(
          'INSERT INTO facade_scopes(incarnation,scope,source_cut,ready,pending_hash) VALUES(?,?,?,?,NULL) ON CONFLICT(incarnation,scope) DO UPDATE SET source_cut=excluded.source_cut,ready=excluded.ready,pending_hash=NULL',
          [
            view.pairing,
            'openid:@' + view.localpart + ':' + view.server,
            record.sequence,
            view.openid !== undefined ? 1 : 0,
          ],
        );
        await conn.execute(
          'INSERT INTO facade_scopes(incarnation,scope,source_cut,ready,pending_hash) VALUES(?,?,?,?,NULL) ON CONFLICT(incarnation,scope) DO UPDATE SET source_cut=excluded.source_cut,ready=excluded.ready,pending_hash=NULL',
          [
            view.pairing,
            'backups:@' + view.localpart + ':' + view.server,
            record.sequence,
            view.backups !== undefined ? 1 : 0,
          ],
        );
        await conn.execute(
          'INSERT INTO facade_scopes(incarnation,scope,source_cut,ready,pending_hash) VALUES(?,?,?,?,NULL) ON CONFLICT(incarnation,scope) DO UPDATE SET source_cut=excluded.source_cut,ready=excluded.ready,pending_hash=NULL',
          [
            view.pairing,
            'pushers:@' + view.localpart + ':' + view.server,
            record.sequence,
            view.pushers !== undefined && view.pusherChoices !== undefined
              ? 1
              : 0,
          ],
        );
        return { kind: 'domain-bootstrap', localpart: view.localpart };
      });
    }
    const history = view.kind === 'domain-history'
      ? await DomainHistoryProof.verify(
        view,
        text(signed.signature),
        context.home.publicKey,
      )
      : undefined;
    if (view.operation.kind === 'notification') {
      await receiveNotificationOperation(
        await this.store.server(),
        view.operation,
        check,
        history,
      );
    } else if (view.operation.kind === 'forget') {
      await importForgetOperation(
        await this.store.server(),
        view.operation,
        check,
        history,
      );
    } else if (view.operation.kind === 'receipt') {
      await importReceiptOperation(
        await this.store.server(),
        view.operation as RegisterOperation & { kind: 'receipt' },
        {
          source: history ? view.operation.source : view.source,
          incarnation: history ? view.operation.incarnation : view.incarnation,
          userId: '@' + view.localpart + ':' + view.server,
        },
        check,
        history,
      );
    } else if (
      view.operation.kind === 'report' ||
      view.operation.kind === 'report-resolution'
    ) {
      await importReportOperation(
        await this.store.server(),
        view.operation,
        check,
        history,
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
          await tx.profiles.import(view.operation, history);
        } else if (view.operation.kind === 'push-rules') {
          await tx.pushRules.import(view.operation, history);
        } else if (view.operation.kind === 'filter') {
          await tx.filters.import(view.operation, history);
        } else if (view.operation.kind === 'openid') {
          await tx.openid.import(view.operation, history);
        } else if (view.operation.kind === 'backup') {
          await tx.keyBackup.import(view.operation, history);
        } else if (['pusher', 'pusher-choice'].includes(view.operation.kind)) {
          await tx.pushers.import(view.operation, history);
        } else await tx.accountData.import(view.operation, history);
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
