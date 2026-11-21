// Membership source export is separate from room-DAG replication and admission.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import type { Conn, Database } from '#engine/store/db.ts';
import type { CommitCheck } from '#engine/store/commit.ts';
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import type { KeyResolver } from '#engine/room/deps.ts';
import type { Pdu } from '#engine/pdu.ts';
import { domainOf } from '#engine/ids.ts';
import { wasHashRedacted } from '#engine/room/verify.ts';
import {
  compatibleEventMaterial,
  prepareEventSignatures,
} from '#engine/room/signatures.ts';
import { openRoom } from '#engine/room/index.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { validatePrejoin } from '#engine/federation/prejoin.ts';
import { membershipDisplay } from '#engine/server/membership-display.ts';
import {
  materializeMembershipDisplay,
  type MembershipEvidence,
} from '#engine/server/membership-application.ts';
import { prejoinResult, savePrejoinResult } from '#engine/server/prejoin.ts';
import { withProjectionLock } from '#engine/server/project.ts';
import { prepareInvitePush } from '#engine/server/push-project.ts';
import { eventStreamTx, onEventStream } from '#engine/server/stream.ts';
import {
  checkedMembershipOperation,
  retainMembershipOperation,
} from '#engine/server/membership-history.ts';
import {
  importPublicKeyFromRaw,
  matrixBase64,
} from '#engine/signing-primitives.js';
import { checkLocalpart } from '#engine/tenant/users.ts';
import {
  type MembershipOperation,
  membershipOperations,
  type MembershipState,
  recordMembershipOperation,
} from '#engine/server/membership-operations.ts';
import {
  type DomainBinding,
  requireAccountExport,
  requireDomainControl,
  requireSelectionReady,
} from './domain-control.ts';
import type { NodeIdentity } from './identity.ts';
import { appendRecord, type Journal } from './journal.ts';
import type { OwnerControl } from './ownership.ts';
import type { Grant, Pairings } from './pairing.ts';
import {
  integer,
  LinkError,
  type LinkRecord,
  object,
  type Stream,
  text,
} from './protocol.ts';
import { signingFence } from './signing-authority.ts';
import { startAccountExports } from './accounts.ts';

/** Membership source facts live in the server file, not the tenant stream.
 * Both roles retain the fair account worker's tenant/periodic recovery while
 * scheduling server-owned OOB commits at their actual post-commit boundary. */
export function startMembershipExports(
  options: Parameters<typeof startAccountExports>[0] & { server: Database },
) {
  const worker = startAccountExports(options);
  const unstream = onEventStream((path) => {
    if (path === options.server.path) worker.wake();
  });
  return {
    wake: worker.wake,
    close: () => {
      unstream();
      return worker.close();
    },
  };
}

type MembershipView = DomainBinding & {
  kind: 'membership-operation' | 'membership-history';
  operation: MembershipOperation;
};

function mismatch(message: string): never {
  throw new LinkError('LINK_IDENTITY_MISMATCH', message, 403);
}

function viewOf(raw: unknown): MembershipView {
  const row = object(raw);
  if (
    row.kind !== 'membership-operation' && row.kind !== 'membership-history'
  ) {
    mismatch('invalid membership record kind');
  }
  const view: MembershipView = {
    kind: row.kind,
    server: text(row.server),
    pairing: text(row.pairing),
    grantRevision: integer(row.grantRevision, 1),
    ownerRevision: integer(row.ownerRevision, 1),
    localpart: text(row.localpart),
    source: text(row.source),
    incarnation: text(row.incarnation),
    operation: checkedMembershipOperation(
      object(row.operation) as MembershipOperation,
    ),
  };
  if (
    canonicalJson(view) !== canonicalJson(raw) ||
    checkLocalpart(view.localpart) !== view.localpart ||
    (view.kind === 'membership-operation' &&
      (view.operation.source !== view.source ||
        view.operation.incarnation !== view.incarnation)) ||
    (view.kind === 'membership-history' && view.source !== 'home') ||
    view.operation.stream !==
      'membership:@' + view.localpart + ':' + view.server
  ) mismatch('membership operation differs from signed source or account');
  return view;
}

function operationId(view: MembershipView) {
  return (view.kind === 'membership-history'
    ? 'membership-history:'
    : 'membership:') + createHash('sha256').update(canonicalJson([
      view.pairing,
      view.grantRevision,
      view.ownerRevision,
      view.operation.operationId,
    ])).digest('hex');
}

function bootstrapScope(binding: DomainBinding) {
  return 'membership-bootstrap:' + canonicalJson(binding);
}

/** The directory describes journal positions, never source operation counters.
 * Require a complete bootstrap under this exact grant/control/source binding,
 * including an explicit empty bootstrap, before publishing that inventory. */
export async function membershipExportPrefix(
  conn: Conn,
  grant: Grant,
  localpart: string,
): Promise<number> {
  const context = grant.body.transcript.body.context;
  const [row] = await conn.query(
    'SELECT c.signed_json FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision WHERE a.pairing=?',
    [context.id],
  );
  const control = row
    ? JSON.parse(String(row.signed_json)).body as OwnerControl
    : null;
  const source = control?.nodes.find((node) => node.node === 'home');
  const unavailable = (): never => {
    throw new LinkError(
      'LINK_UNAVAILABLE',
      'directory awaits membership bootstrap',
      503,
    );
  };
  if (!source || !control) return unavailable();
  const binding: DomainBinding = {
    server: context.server,
    pairing: context.id,
    grantRevision: grant.body.revision,
    ownerRevision: control.revision,
    localpart,
    source: source.node,
    incarnation: source.incarnation,
  };
  await requireDomainControl(conn, binding);
  const [declared] = await conn.query(
    'SELECT source_cut FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
    [context.node, context.id, bootstrapScope(binding)],
  );
  if (!declared) return unavailable();
  const [head] = await conn.query(
    "SELECT received FROM facade_streams WHERE peer=? AND direction='out' AND source='home' AND incarnation=? AND stream=?",
    [
      context.node,
      context.id,
      'membership:@' + localpart + ':' + context.server,
    ],
  );
  const cut = Number(head?.received ?? 0);
  if (cut < Number(declared.source_cut)) {
    throw new LinkError(
      'LINK_DIVERGED',
      'membership bootstrap prefix regressed',
    );
  }
  return cut;
}

/** A contiguous journal must never put a successor ahead of evidence needed to
 * apply that same head. Source counters retain their order across rooms too. */
function bootstrapOrder(operations: MembershipOperation[]) {
  const remaining = [...operations], ordered: MembershipOperation[] = [];
  const admitted = new Map<string, MembershipOperation>();
  while (remaining.length) {
    const at = remaining.findIndex((operation) =>
      operation.context.every((dot) => {
        const predecessor = admitted.get(canonicalJson([
          dot.source,
          dot.incarnation,
          operation.stream,
          dot.sequence,
        ]));
        return predecessor?.semanticKey === operation.semanticKey;
      }) && !remaining.some((prior) =>
        prior.source === operation.source &&
        prior.incarnation === operation.incarnation &&
        prior.stream === operation.stream && prior.sequence < operation.sequence
      )
    );
    if (at < 0) {
      throw new LinkError(
        'LINK_UNAVAILABLE',
        'membership bootstrap awaits historical predecessors',
        503,
      );
    }
    const [operation] = remaining.splice(at, 1);
    ordered.push(operation);
    admitted.set(operation.operationId, operation);
  }
  return ordered;
}

/** Verify original signed evidence without countersigning or installing a room.
 * A terminal row may render a leave while retaining the original invite ID. */
async function preparedState(
  operation: MembershipOperation,
  keys: KeyResolver,
): Promise<{ state: MembershipState; evidence: MembershipEvidence }> {
  const state = JSON.parse(operation.payload) as MembershipState;
  const inRoom = async (raw: string) => {
    const prepared = await prepareEventSignatures(
      JSON.parse(raw) as Pdu,
      state.roomVersion,
      keys,
      {
        roomId: state.roomId,
      },
    );
    if (
      prepared.pdu.room_id !== undefined &&
      prepared.pdu.room_id !== state.roomId
    ) {
      mismatch('membership PDU differs from retained room');
    }
    prepared.pdu.signatures = structuredClone(prepared.evidence.signatures);
    return prepared;
  };
  const receipt = await inRoom(state.eventJson);
  const event = receipt.pdu;
  const membership = event.content?.membership;
  const original = membership === state.kind;
  if (
    event.type !== 'm.room.member' || event.state_key !== state.userId ||
    (!original &&
      (state.status !== 'rejected' ||
        !['leave', 'ban'].includes(String(membership)))) ||
    (original && String(event.event_id) !== state.eventId) ||
    (state.kind === 'invite' && original &&
      domainOf(event.sender) !== state.origin) ||
    (state.kind === 'knock' && original && event.sender !== state.userId)
  ) mismatch('membership PDU differs from retained lifecycle');
  let localLeaveJson = state.localLeaveJson;
  const departure = localLeaveJson === null
    ? null
    : await inRoom(localLeaveJson);
  if (localLeaveJson !== null) {
    const leave = departure!.pdu;
    if (
      leave.type !== 'm.room.member' || leave.state_key !== state.userId ||
      leave.sender !== state.userId || leave.content?.membership !== 'leave'
    ) mismatch('membership departure differs from local user');
    localLeaveJson = canonicalJson(leave);
  }
  // The immutable operation retains original evidence. Only the verifier's
  // normalized PDU can subsequently supply a materialized display.
  return {
    state: { ...state, eventJson: canonicalJson(event), localLeaveJson },
    evidence: {
      event: receipt.evidence,
      localLeave: departure?.evidence ?? null,
      provenance: {
        event: wasHashRedacted(event),
        localLeave: departure !== null && wasHashRedacted(departure.pdu),
      },
    },
  };
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
    if (!this.node) {
      await requireAccountExport(conn, {
        peer: context.node,
        pairing: context.id,
        server: context.server,
        localpart,
      });
      return;
    }
    const [selected] = await conn.query(
      'SELECT 1 FROM facade_scopes WHERE incarnation=? AND scope=? AND ready=1',
      [context.id, 'auth:@' + localpart + ':' + context.server],
    );
    requireSelectionReady(
      !!selected,
      'membership account not selected: awaiting applied auth snapshot',
    );
  }

  /** Retention alone never completes a journal record or changes a display.
   * A retry without an application receipt still requires current authority. */
  async retain(
    record: LinkRecord,
    keys: KeyResolver,
    pairing?: string,
  ): Promise<MembershipState> {
    if (record.type !== 'membership-operation' || record.version !== 1) {
      throw new LinkError(
        'LINK_CAPABILITY_MISMATCH',
        'not membership operation',
      );
    }
    const signed = object(record.payload), view = viewOf(signed.body);
    const server = await this.store.server(), unchanged = signingFence(server);
    const grant = await this.binding(pairing),
      context = grant.body.transcript.body.context;
    const peer = this.node ? 'home' : context.node;
    if (
      view.server !== this.tenant.serverName ||
      view.server !== context.server ||
      view.pairing !== context.id ||
      view.grantRevision !== grant.body.revision ||
      view.source !== peer || record.source !== peer ||
      record.incarnation !==
        (this.node ? context.id : grant.body.transcript.body.incarnation) ||
      record.stream !== view.operation.stream ||
      record.operationId !== operationId(view)
    ) mismatch('membership record differs from enrolled source or scope');
    let valid = false;
    try {
      valid = await crypto.subtle.verify(
        'Ed25519',
        await importPublicKeyFromRaw(
          matrixBase64(
            this.node
              ? context.home.publicKey
              : grant.body.transcript.body.key.publicKey,
            32,
          ),
        ),
        matrixBase64(text(signed.signature), 64),
        new TextEncoder().encode(canonicalJson(view)),
      );
    } catch {
      /* Invalid signatures cannot grant retained membership authority. */
    }
    if (!valid) mismatch('invalid membership operation signature');
    if (view.kind === 'membership-history' && !this.node) {
      mismatch('only home may attest membership history');
    }
    await server.tx(async (conn) => {
      conn.admit(unchanged);
      await this.selected(conn, grant, view.localpart);
      await requireDomainControl(conn, view);
    });
    const prepared = await preparedState(view.operation, keys);
    await server.tx(async (conn) => {
      conn.admit(unchanged);
      await this.selected(conn, grant, view.localpart);
      await requireDomainControl(conn, view);
      await retainMembershipOperation(conn, view.operation);
    });
    return prepared.state;
  }

  /** Semantic completion precedes journal ACK. The exact saved record can
   * finish after retirement; retained evidence alone cannot grant new work. */
  async apply(
    journal: Journal,
    stream: Stream,
    keys: KeyResolver,
    pairing?: string,
  ): Promise<boolean> {
    if (!this.node && !pairing) {
      mismatch('home membership exchange requires pairing');
    }
    const peer = this.node ? 'home' : stream.source;
    const record = await journal.next(peer, stream);
    if (!record) return false;
    if (record.type !== 'membership-operation' || record.version !== 1) {
      throw new LinkError(
        'LINK_CAPABILITY_MISMATCH',
        'not membership operation',
      );
    }
    const view = viewOf(object(record.payload).body);
    if (
      view.server !== this.tenant.serverName ||
      (!this.node && view.pairing !== pairing)
    ) mismatch('membership completion differs from local scope');
    const server = await this.store.server();
    const application = canonicalJson([
      'link',
      peer,
      record.source,
      record.incarnation,
      record.stream,
      record.sequence,
    ]);
    const prior = await prejoinResult(server, application, record.hash);
    if (prior !== null) {
      await journal.complete(peer, stream, record, prior);
      return true;
    }
    const unchanged = signingFence(server);
    await this.retain(record, keys, pairing);
    const grant = await this.binding(pairing);
    const selection = await server.tx((conn) =>
      membershipDisplay(conn, view.operation.semanticKey, false)
    );
    if (
      !selection.ready.some((op) =>
        op.operationId === view.operation.operationId
      )
    ) {
      throw new LinkError(
        'LINK_UNAVAILABLE',
        'membership application awaits historical predecessors',
        503,
      );
    }
    // All validation and tenant policy capture happens before room/server locks.
    // Optional signature overlays join only after the shared verifier accepts them.
    const normalized: Awaited<ReturnType<typeof preparedState>>[] = [];
    for (const operation of selection.display) {
      const prepared = await preparedState(operation, keys);
      const state = prepared.state;
      normalized.push({
        ...prepared,
        state: {
          ...state,
          inviteRoomState: canonicalJson(
            await validatePrejoin(
              JSON.parse(state.inviteRoomState),
              state.roomId,
              state.roomVersion,
              keys,
            ),
          ),
        },
      });
    }
    // A source lifecycle fact may have no OOB display (notably a completed
    // join). Verified execution intent is retained without client news;
    // completed outcomes need display evidence or locked receiver DAG authority.
    const prepared = normalized[0] ?? await preparedState(view.operation, keys);
    const state = prepared.state;
    const event = JSON.parse(state.eventJson) as Pdu;
    for (const other of normalized.slice(1)) {
      const pdu = JSON.parse(other.state.eventJson) as Pdu;
      if (
        !await compatibleEventMaterial(
          event,
          other.evidence.event,
          normalized[0].evidence.provenance.event,
        )
      ) {
        throw new LinkError(
          'LINK_DIVERGED',
          'selected membership event material changed',
        );
      }
      for (const [origin, signatures] of Object.entries(pdu.signatures ?? {})) {
        event.signatures ??= {};
        event.signatures[origin] = {
          ...event.signatures[origin],
          ...signatures,
        };
      }
    }
    state.eventJson = canonicalJson(event);
    const evidence: MembershipEvidence = {
      ...prepared.evidence,
      event: {
        ...prepared.evidence.event,
        signatures: event.signatures ?? {},
      },
    };
    const publication = selection.display.length
      ? await prepareInvitePush(this.store, view.server, event)
      : null;
    const intentOnly = (state.kind === 'knock' &&
      ['attempting', 'failed-attempt'].includes(state.status)) ||
      (state.localLeaveJson === null &&
        ['rejecting', 'failed-retract'].includes(state.status));
    const result = await withRoomLock(
      state.roomId,
      () =>
        withProjectionLock(async () => {
          if (await this.store.roomRetired(state.roomId)) {
            throw new LinkError(
              'LINK_UNAVAILABLE',
              'membership room removal is pending',
              503,
            );
          }
          const held = (await this.store.rooms()).includes(state.roomId) &&
            await (await openRoom(this.store, state.roomId)).tx(async (tx) =>
              (await tx.segments.openStay()) !== null
            );
          if (!held && !selection.display.length && !intentOnly) {
            throw new LinkError(
              'LINK_UNAVAILABLE',
              'membership application awaits display evidence',
              503,
            );
          }
          return await eventStreamTx(server, async (conn) => {
            const retained = await prejoinResult(
              conn,
              application,
              record.hash,
            );
            if (retained !== null) return retained;
            conn.admit(unchanged);
            await this.selected(conn, grant, view.localpart);
            await requireDomainControl(conn, view);
            const [published] = await conn.query(
              'SELECT event FROM memberships WHERE room=? AND user=?',
              [state.roomId, state.userId],
            );
            // A new receiver position cannot make old OOB evidence overtake a
            // newer normal publication or replace a held room's DAG authority.
            if (
              !held && publication !== null &&
              (!published || normalized.every((value) =>
                value.state.publication?.eventId === published.event &&
                value.state.publication.follows
              ))
            ) {
              await materializeMembershipDisplay(
                conn,
                selection.display,
                state,
                evidence,
                publication,
                Date.now(),
              );
            }
            await conn.execute(
              "UPDATE domain_operations SET applied=1 WHERE operation_id=? AND kind='membership'",
              [view.operation.operationId],
            );
            const result = await savePrejoinResult(
              conn,
              application,
              state.roomId,
              record.hash,
              { operationId: view.operation.operationId },
            );
            return result;
          });
        }),
    );
    await journal.complete(peer, stream, record, result);
    return true;
  }

  private async exportBinding(localpart: string, pairing?: string) {
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
    return { grant, source, binding };
  }

  /** Home separately attests exact retained history, including foreign dots and
   * prior incarnations. This supplies evidence, not a scope-ready declaration or
   * an application receipt. Ordinary export never echoes imported authorship. */
  async bootstrap(localpart: string, pairing: string): Promise<LinkRecord[]> {
    if (this.node) mismatch('only home may attest membership history');
    const { grant, source, binding } = await this.exportBinding(
      localpart,
      pairing,
    );
    const server = await this.store.server(), unchanged = signingFence(server);
    const operations = await server.tx(async (conn) => {
      conn.admit(unchanged);
      await this.selected(conn, grant, localpart);
      await requireDomainControl(conn, binding);
      await conn.execute(
        'DELETE FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
        [
          grant.body.transcript.body.context.node,
          pairing,
          bootstrapScope(binding),
        ],
      );
      const userId = '@' + localpart + ':' + binding.server;
      for (
        const row of await conn.query(
          'SELECT room_id FROM prejoin_memberships WHERE user_id=?',
          [userId],
        )
      ) {
        await recordMembershipOperation(conn, String(row.room_id), userId);
      }
      return await membershipOperations(conn, userId);
    });
    // Compute the complete schedule before any append/cut. Historical evidence
    // and current authorship share this journal, so two separate export passes
    // could deadlock its first successor on history queued behind that head.
    const ordered = bootstrapOrder(operations);
    const records: LinkRecord[] = [];
    for (const operation of ordered) {
      const view = viewOf({
        ...binding,
        kind: operation.source === source.node &&
            operation.incarnation === source.incarnation
          ? 'membership-operation'
          : 'membership-history',
        operation,
      });
      const record = await this.append(view, grant, unchanged, true);
      if (record) records.push(record);
    }
    // Only the completed ordered schedule may declare inventory completeness.
    // A partial append, missing history or changed authority leaves no new
    // declaration. This also commits the otherwise indistinguishable zero case.
    await server.tx(async (conn) => {
      conn.admit(unchanged);
      await this.selected(conn, grant, localpart);
      await requireDomainControl(conn, binding);
      const [head] = await conn.query(
        "SELECT received FROM facade_streams WHERE peer=? AND direction='out' AND source='home' AND incarnation=? AND stream=?",
        [
          grant.body.transcript.body.context.node,
          pairing,
          'membership:@' + localpart + ':' + binding.server,
        ],
      );
      await conn.execute(
        'INSERT INTO facade_exports(peer,incarnation,scope,source_cut) VALUES(?,?,?,?) ON CONFLICT(peer,incarnation,scope) DO UPDATE SET source_cut=excluded.source_cut',
        [
          grant.body.transcript.body.context.node,
          pairing,
          bootstrapScope(binding),
          Number(head?.received ?? 0),
        ],
      );
    });
    return records;
  }

  private async append(
    view: MembershipView,
    grant: Grant,
    unchanged: CommitCheck,
    replay = false,
  ) {
    const server = await this.store.server();
    const context = grant.body.transcript.body.context;
    const peer = this.node ? 'home' : context.node;
    const signed = {
      body: view,
      signature: await (this.node?.signer() ?? this.tenant.signer()).sign(
        canonicalJson(view),
      ),
    };
    return await server.tx(async (conn) => {
      conn.admit(unchanged);
      await this.selected(conn, grant, view.localpart);
      await requireDomainControl(conn, view);
      const { kind: _kind, operation: _operation, ...binding } = view;
      const scope = 'membership-export:' + canonicalJson(binding);
      if (view.kind === 'membership-operation' && !replay) {
        const [current] = await conn.query(
          'SELECT source_cut FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
          [peer, context.id, scope],
        );
        if (Number(current?.source_cut ?? 0) >= view.operation.sequence) {
          return null;
        }
      }
      const [control] = await conn.query(
        'SELECT c.signed_json FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision WHERE a.pairing=?',
        [view.pairing],
      );
      const receiver =
        (JSON.parse(String(control.signed_json)).body as OwnerControl)
          .nodes.find((node) => node.node === peer);
      for (const dot of view.operation.context) {
        const predecessor = canonicalJson([
          dot.source,
          dot.incarnation,
          view.operation.stream,
          dot.sequence,
        ]);
        const retained = await conn.query(
          "SELECT 1 FROM domain_operations WHERE operation_id=? AND semantic_key=? AND kind='membership'",
          [predecessor, view.operation.semanticKey],
        );
        // The current receiver authored its own durable facts. Every other
        // dependency must precede this append, including ordinary export calls
        // racing bootstrap. Never queue a blocked head and its evidence later.
        const owned = receiver?.node === dot.source &&
          receiver.incarnation === dot.incarnation;
        const prior = operationId({
          ...view,
          kind:
            dot.source === view.source && dot.incarnation === view.incarnation
              ? 'membership-operation'
              : 'membership-history',
          operation: { ...view.operation, operationId: predecessor },
        });
        const sent = owned ? true : (await conn.query(
          "SELECT 1 FROM facade_records WHERE peer=? AND direction='out' AND source=? AND incarnation=? AND operation_id=?",
          [peer, view.source, this.node ? view.incarnation : context.id, prior],
        )).length > 0;
        if (!retained.length || !sent) {
          throw new LinkError(
            'LINK_UNAVAILABLE',
            'membership export awaits historical predecessors',
            503,
          );
        }
      }
      const record = await appendRecord(conn, peer, {
        source: view.source,
        incarnation: this.node ? view.incarnation : context.id,
        stream: view.operation.stream,
        type: 'membership-operation',
        version: 1,
        operationId: operationId(view),
        payload: signed,
      });
      if (view.kind === 'membership-operation') {
        await conn.execute(
          'INSERT INTO facade_exports(peer,incarnation,scope,source_cut) VALUES(?,?,?,?) ON CONFLICT(peer,incarnation,scope) DO UPDATE SET source_cut=MAX(source_cut,excluded.source_cut)',
          [peer, context.id, scope, view.operation.sequence],
        );
      }
      return record;
    });
  }

  /** Only committed immutable source facts are signed. A mutable display scan
   * could erase an accepted invite/rejection before the link ever saw it. */
  async export(localpart: string, pairing?: string): Promise<LinkRecord[]> {
    const { grant, source, binding } = await this.exportBinding(
      localpart,
      pairing,
    );
    const context = grant.body.transcript.body.context;
    const server = await this.store.server(), unchanged = signingFence(server);
    const peer = this.node ? 'home' : context.node;
    const scope = 'membership-export:' + canonicalJson(binding);
    const operations = await server.tx(async (conn) => {
      conn.admit(unchanged);
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
      const record = await this.append(view, grant, unchanged);
      if (record) records.push(record);
    }
    return records;
  }
}
