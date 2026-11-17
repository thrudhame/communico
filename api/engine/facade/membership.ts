// Membership source export is separate from room-DAG replication and admission.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import type { KeyResolver } from '#engine/room/deps.ts';
import type { Pdu } from '#engine/pdu.ts';
import { domainOf } from '#engine/ids.ts';
import { verify } from '#engine/room/verify.ts';
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
import { type DomainBinding, requireDomainControl } from './domain-control.ts';
import type { NodeIdentity } from './identity.ts';
import { appendRecord } from './journal.ts';
import type { OwnerControl } from './ownership.ts';
import type { Grant, Pairings } from './pairing.ts';
import {
  integer,
  LinkError,
  type LinkRecord,
  object,
  text,
} from './protocol.ts';
import { signingFence } from './signing-authority.ts';

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
async function verifiedState(
  operation: MembershipOperation,
  keys: KeyResolver,
): Promise<MembershipState> {
  const state = JSON.parse(operation.payload) as MembershipState;
  const inRoom = async (raw: string) => {
    const { pdu } = await verify(
      JSON.parse(raw) as Pdu,
      state.roomVersion,
      keys,
      {
        roomId: state.roomId,
      },
    );
    if (pdu.room_id !== undefined && pdu.room_id !== state.roomId) {
      mismatch('membership PDU differs from retained room');
    }
    return pdu;
  };
  const event = await inRoom(state.eventJson);
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
  if (localLeaveJson !== null) {
    const leave = await inRoom(localLeaveJson);
    if (
      leave.type !== 'm.room.member' || leave.state_key !== state.userId ||
      leave.sender !== state.userId || leave.content?.membership !== 'leave'
    ) mismatch('membership departure differs from local user');
    localLeaveJson = canonicalJson(leave);
  }
  // The immutable operation retains original evidence. Only the verifier's
  // normalized PDU can subsequently supply a materialized display.
  return { ...state, eventJson: canonicalJson(event), localLeaveJson };
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
      unchanged();
      await this.selected(conn, grant, view.localpart);
      await requireDomainControl(conn, view);
    });
    const state = await verifiedState(view.operation, keys);
    await server.tx(async (conn) => {
      unchanged();
      await this.selected(conn, grant, view.localpart);
      await requireDomainControl(conn, view);
      await retainMembershipOperation(conn, view.operation);
      unchanged();
    });
    return state;
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
      unchanged();
      await this.selected(conn, grant, localpart);
      await requireDomainControl(conn, binding);
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
    return records;
  }

  private async append(
    view: MembershipView,
    grant: Grant,
    unchanged: () => void,
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
      unchanged();
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
      unchanged();
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
      const record = await this.append(view, grant, unchanged);
      if (record) records.push(record);
    }
    return records;
  }
}
