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
import {
  captureDevicePublications,
  type DevicePublication,
  importDevicePublication,
} from '#engine/tenant/device-stream.ts';
import {
  keyChangesCut,
  publicKeysChangedAfter,
} from '#engine/tenant/changes.ts';
import {
  captureSigningOperations,
  importSigningOperation,
  type SigningOperation,
} from '#engine/tenant/signing-operations.ts';
import {
  captureSignatureOperations,
  importSignatureOperation,
  type SignatureOperation,
} from '#engine/tenant/signature-operations.ts';
import {
  applyLinkApplication,
  linkApplication,
  linkApplicationProjection,
} from '#engine/tenant/link-applications.ts';
import { checkLocalpart } from '#engine/tenant/users.ts';
import { tenantChangesCommitted } from '#engine/tenant/hooks.ts';
import {
  captureKeyHistory,
  type KeyBootstrap,
  type KeyHistory,
  KeyHistoryProof,
  type KeyKind,
  type KeyManifest,
  type KeyOperation,
  retainKeyBootstrap,
} from '#engine/tenant/key-bootstrap.ts';
import {
  type DomainBinding,
  requireAccountExport,
  requireAccountSelection,
  requireDomainControl,
} from './domain-control.ts';
import type { NodeIdentity } from './identity.ts';
import { appendRecord, type Journal } from './journal.ts';
import type { OwnerControl } from './ownership.ts';
import type { Grant, Pairings } from './pairing.ts';
import { integer, LinkError, object, type Stream, text } from './protocol.ts';
import { signingFence } from './signing-authority.ts';

export type DeviceView = DomainBinding & {
  kind: 'device-operation';
  operation: DeviceOperation;
};
type SigningView = DomainBinding & {
  kind: 'signing-operation';
  operation: SigningOperation;
};
type SignatureView = DomainBinding & {
  kind: 'signature-operation';
  operation: SignatureOperation;
};
type PublicationView = DomainBinding & {
  kind: 'device-publication';
  operation: DevicePublication;
};
type KeyView = DeviceView | SigningView | SignatureView | PublicationView;
type KeyEnvelope = KeyView | KeyBootstrap | KeyHistory;
const keyKinds = {
  'device-operation': { prefix: 'device:', stream: 'devices:@' },
  'signing-operation': { prefix: 'signing:', stream: 'signing:@' },
  'signature-operation': { prefix: 'signature:', stream: 'signatures:@' },
  'device-publication': {
    prefix: 'publication:',
    stream: 'device-publications:@',
  },
} as const;

function keyKind(value: string): value is KeyView['kind'] {
  return Object.hasOwn(keyKinds, value);
}

export function isKeyStream(stream: Stream): boolean {
  return stream.stream.startsWith('key-bootstrap:@') ||
    stream.stream.startsWith('key-history:@') ||
    Object.values(keyKinds).some(({ stream: prefix }) =>
      stream.stream.startsWith(prefix)
    );
}

function mismatch(message: string): never {
  throw new LinkError('LINK_IDENTITY_MISMATCH', message, 403);
}

function viewOf(raw: unknown, version = 2): KeyEnvelope {
  const row = object(raw);
  const localpart = text(row.localpart);
  if (
    typeof row.kind !== 'string' ||
    (!keyKind(row.kind) && row.kind !== 'key-bootstrap' &&
      row.kind !== 'key-history')
  ) {
    mismatch('unknown public key operation');
  }
  const binding: DomainBinding = {
    server: text(row.server),
    pairing: text(row.pairing),
    grantRevision: integer(row.grantRevision, 1),
    ownerRevision: integer(row.ownerRevision, 1),
    localpart,
    source: text(row.source),
    incarnation: text(row.incarnation),
  };
  let view: KeyEnvelope;
  if (row.kind === 'key-bootstrap') {
    const manifest = object(row.manifest), parsed = {} as KeyManifest;
    for (const kind of Object.keys(keyKinds) as KeyKind[]) {
      if (version === 1 && kind === 'device-publication') continue;
      const refs = manifest[kind];
      if (!Array.isArray(refs)) mismatch('invalid key manifest');
      parsed[kind] = refs.map((raw) => {
        const fact = object(raw), payloadHash = text(fact.payloadHash);
        if (!/^[a-f0-9]{64}$/.test(payloadHash)) {
          mismatch('invalid key manifest hash');
        }
        return { operationId: text(fact.operationId), payloadHash };
      }).sort((a, b) =>
        a.operationId < b.operationId
          ? -1
          : a.operationId > b.operationId
          ? 1
          : 0
      );
      if (
        new Set(parsed[kind]!.map((fact) => fact.operationId)).size !==
          parsed[kind]!.length
      ) mismatch('duplicate key manifest fact');
    }
    view = { ...binding, kind: 'key-bootstrap', manifest: parsed };
  } else if (row.kind === 'key-history') {
    if (
      typeof row.keyKind !== 'string' || !keyKind(row.keyKind) ||
      (version === 1 && row.keyKind === 'device-publication')
    ) {
      mismatch('invalid historical key kind');
    }
    view = {
      ...binding,
      kind: 'key-history',
      keyKind: row.keyKind,
      operation: object(row.operation) as KeyOperation,
      ...(row.keyKind === 'device-operation'
        ? { creation: object(row.creation) as KeyHistory['creation'] }
        : {}),
    };
  } else {
    view = {
      ...binding,
      kind: row.kind as KeyView['kind'],
      operation: object(row.operation),
    } as KeyView;
  }
  if (
    checkLocalpart(localpart) !== localpart ||
    canonicalJson(view) !== canonicalJson(raw) ||
    (view.kind === 'key-bootstrap'
      ? view.source !== 'home'
      : view.operation.localpart !== localpart || (view.kind === 'key-history'
        ? view.source !== 'home'
        : view.operation.source !== view.source ||
          view.operation.incarnation !== view.incarnation))
  ) mismatch('device operation differs from signed source or account');
  return view;
}

function operationId(view: KeyEnvelope) {
  if (view.kind === 'key-bootstrap' || view.kind === 'key-history') {
    return view.kind + ':' +
      createHash('sha256').update(canonicalJson(view)).digest('hex');
  }
  return keyKinds[view.kind].prefix +
    createHash('sha256').update(canonicalJson([
      view.pairing,
      view.grantRevision,
      view.ownerRevision,
      view.operation.operationId,
    ])).digest('hex');
}

function streamName(
  kind: KeyEnvelope['kind'],
  localpart: string,
  server: string,
) {
  return (keyKind(kind) ? keyKinds[kind].stream : kind + ':@') + localpart +
    ':' + server;
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
    if (!this.node) {
      await requireAccountExport(conn, {
        peer: context.node,
        pairing: context.id,
        server: context.server,
        localpart,
      });
    }
  }

  private async tenantSelected(conn: Conn, view: DomainBinding) {
    await requireDomainControl(conn, view);
    if (!this.node) return;
    await requireAccountSelection(conn, view);
  }

  /** Export original local owner intent only. Full bootstrap/history and public
   * reader activation are separate contracts, not implied by this suffix. */
  async export(localpart: string, pairing?: string) {
    return await this.exportOperations('device-operation', localpart, pairing);
  }

  /** Home-authored complete cross-signing identities share the device link's
   * admission/receipt contract, but have their own independently drained stream. */
  async exportSigning(localpart: string, pairing?: string) {
    return await this.exportOperations('signing-operation', localpart, pairing);
  }

  /** Verified overlays travel independently of the owner of their target keys. */
  async exportSignatures(localpart: string, pairing?: string) {
    return await this.exportOperations(
      'signature-operation',
      localpart,
      pairing,
    );
  }

  /** Runtime suffix composition, not a semantic completeness declaration. Each
   * type retains its own journal so a pending dependency cannot block its peers. */
  async exportChanges(localpart: string, pairing?: string) {
    const results = await Promise.allSettled([
      this.export(localpart, pairing),
      this.exportSigning(localpart, pairing),
      this.exportSignatures(localpart, pairing),
    ]);
    // Capture after source owners settle, including when one is unavailable.
    // Its independent journal still drains the retained publication evidence.
    results.push(
      ...await Promise.allSettled([
        this.exportPublications(localpart, pairing),
      ]),
    );
    const records = [];
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      records.push(...result.value);
    }
    return records;
  }

  async exportPublications(localpart: string, pairing?: string) {
    return await this.exportOperations(
      'device-publication',
      localpart,
      pairing,
    );
  }

  /** The same source owners capture one complete tenant cut; each dependency
   * keeps its own stream. A separate declaration can wait without blocking them. */
  async bootstrap(localpart: string, pairing: string) {
    if (this.node) mismatch('only home may declare key bootstrap');
    const { grant, binding } = await this.accountBinding(localpart, pairing);
    const history = await (await this.store.tenant(binding.server)).tx(
      async (conn) => {
        await this.tenantSelected(conn, binding);
        return await captureKeyHistory(conn, localpart);
      },
    );
    const records = [];
    const manifest = {} as KeyManifest;
    for (const kind of Object.keys(keyKinds) as KeyKind[]) {
      manifest[kind] = history[kind].map(({ operationId, payloadHash }) => ({
        operationId,
        payloadHash,
      }));
      for (const operation of history[kind]) {
        const view = operation.source === binding.source &&
            operation.incarnation === binding.incarnation
          ? viewOf({ ...binding, kind, operation })
          : viewOf({
            ...binding,
            kind: 'key-history',
            keyKind: kind,
            operation,
            ...(kind === 'device-operation'
              ? {
                creation: history.creations.get(
                  (operation as DeviceOperation).deviceIncarnation,
                ),
              }
              : {}),
          });
        records.push(await this.publish(view, grant));
      }
    }
    records.push(
      await this.publish(
        viewOf({ ...binding, kind: 'key-bootstrap', manifest }),
        grant,
      ),
    );
    return records;
  }

  private async publish(view: KeyEnvelope, grant: Grant) {
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
        stream: streamName(view.kind, view.localpart, view.server),
        type: view.kind,
        // Existing historical envelopes keep their original immutable record
        // version. Only the extended manifest/publication history requires v2.
        version: view.kind === 'key-bootstrap' ||
            (view.kind === 'key-history' &&
              view.keyKind === 'device-publication')
          ? 2
          : 1,
        operationId: operationId(view),
        payload: signed,
      });
    });
  }

  private async accountBinding(localpart: string, pairing?: string) {
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
    return { grant, binding };
  }

  private async exportOperations(
    kind: KeyKind,
    localpart: string,
    pairing?: string,
  ) {
    const { grant, binding } = await this.accountBinding(localpart, pairing);
    const operations = await (await this.store.tenant(binding.server)).tx(
      async (conn) => {
        await this.tenantSelected(conn, binding);
        switch (kind) {
          case 'device-operation':
            return await captureDeviceOperations(conn, localpart);
          case 'signing-operation':
            return await captureSigningOperations(conn, localpart);
          case 'signature-operation':
            return await captureSignatureOperations(conn, localpart);
          case 'device-publication':
            return (await captureDevicePublications(conn, localpart)).filter((
              operation,
            ) =>
              operation.source === binding.source &&
              operation.incarnation === binding.incarnation
            );
        }
      },
    );
    const records = [];
    for (const operation of operations) {
      const view = viewOf({ ...binding, kind, operation });
      records.push(await this.publish(view, grant));
    }
    return records;
  }

  async apply(
    journal: Journal,
    stream: Stream,
    pairing?: string,
  ): Promise<boolean> {
    if (!this.node && !pairing) {
      mismatch('home device exchange requires pairing');
    }
    const peer = this.node ? 'home' : stream.source;
    const record = await journal.next(peer, stream);
    if (!record) return false;
    if (
      (!keyKind(record.type) && record.type !== 'key-bootstrap' &&
        record.type !== 'key-history') ||
      (record.type === 'key-bootstrap' || record.type === 'key-history'
        ? record.version !== 1 && record.version !== 2
        : record.version !== 1)
    ) {
      throw new LinkError('LINK_CAPABILITY_MISMATCH', 'not device operation');
    }
    const signed = object(record.payload),
      view = viewOf(
        signed.body,
        record.type === 'key-bootstrap' || record.type === 'key-history'
          ? record.version
          : 2,
      );
    if (
      view.kind !== record.type || view.server !== this.tenant.serverName ||
      (!this.node && view.pairing !== pairing)
    ) {
      mismatch('device completion differs from local scope');
    }
    const tenant = await this.store.tenant(this.tenant.serverName);
    const { prior, projectionRevision } = await tenant.tx(async (conn) => {
      const prior = await linkApplication(conn, peer, record);
      return {
        prior,
        projectionRevision: prior
          ? await linkApplicationProjection(conn, prior)
          : 0,
      };
    });
    if (prior) {
      const { publicKeysChanged, ...result } = object(prior.result);
      await tenantChangesCommitted(
        this.store,
        this.tenant.serverName,
        projectionRevision,
        false,
        'replica',
        publicKeysChanged === true,
      );
      await journal.complete(peer, stream, record, result);
      return true;
    }
    const server = await this.store.server();
    const unchanged = signingFence(server);
    const grant = await this.binding(pairing),
      context = grant.body.transcript.body.context;
    if (
      view.server !== context.server || view.pairing !== context.id ||
      view.grantRevision !== grant.body.revision || view.source !== peer ||
      peer !== (this.node ? 'home' : context.node) ||
      record.source !== peer ||
      record.incarnation !==
        (this.node ? context.id : grant.body.transcript.body.incarnation) ||
      record.stream !== streamName(view.kind, view.localpart, view.server) ||
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
    if (
      (view.kind === 'key-bootstrap' || view.kind === 'key-history') &&
      !this.node
    ) mismatch('only home may attest key history or completeness');
    const history = view.kind === 'key-history'
      ? await KeyHistoryProof.verify(
        view,
        text(signed.signature),
        context.home.publicKey,
      )
      : undefined;
    const check = async (conn: Conn) => {
      await this.selected(conn, grant, view.localpart);
      await requireDomainControl(conn, view);
    };
    await server.tx(check);
    const application = await tenant.tx(
      async (conn) => {
        unchanged();
        await this.tenantSelected(conn, view);
        const applied = await applyLinkApplication(
          conn,
          peer,
          record,
          async () => {
            const keyCut = await keyChangesCut(conn);
            if (view.kind === 'key-bootstrap') {
              await retainKeyBootstrap(
                conn,
                view,
                record.sequence,
                record.hash,
              );
            } else {
              const kind = view.kind === 'key-history'
                ? view.keyKind
                : view.kind;
              const expected = {
                source: view.operation.source,
                incarnation: view.operation.incarnation,
                localpart: view.localpart,
              };
              if (kind === 'device-operation') {
                await importDeviceOperation(
                  conn,
                  view.operation,
                  expected,
                  history,
                );
              } else if (kind === 'signing-operation') {
                await importSigningOperation(
                  conn,
                  view.operation,
                  expected,
                  history,
                );
              } else if (kind === 'signature-operation') {
                await importSignatureOperation(
                  conn,
                  view.operation,
                  expected,
                  history,
                );
              } else {
                await importDevicePublication(
                  conn,
                  view.operation,
                  expected,
                  history,
                );
              }
            }
            const result = {
              operationId: view.kind === 'key-bootstrap'
                ? record.operationId
                : view.operation.operationId,
            };
            const publicKeysChanged = await publicKeysChangedAfter(
              conn,
              keyCut,
            );
            return { result: { ...result, publicKeysChanged } };
          },
        );
        // This synchronous fence is the admission cut. A retirement begun before
        // it rolls back fact + receipt. Once it passes, a successful owner commit
        // is admitted immutable work, even if revocation overlaps native COMMIT.
        unchanged();
        return applied;
      },
    );
    const { publicKeysChanged, ...result } = application.result;
    await tenantChangesCommitted(
      this.store,
      this.tenant.serverName,
      application.projectionRevision,
      false,
      'replica',
      publicKeysChanged,
    );
    // Completion cannot retroactively revoke admitted work. After ACK loss,
    // only the exact durable receipt can take this path, including cold replay.
    await journal.complete(peer, stream, record, result);
    return true;
  }
}
