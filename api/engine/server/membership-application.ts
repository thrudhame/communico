// Materialization owns receiver-local publication, never foreign work or source
// authorship. The link adapter supplies verified, normalized selected evidence.
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  compatibleEventMaterial,
  type SignatureEvidence,
} from '#engine/room/signatures.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Conn } from '#engine/store/db.ts';
import { membershipDisplay } from './membership-display.ts';
import { bindMembershipDisplay } from './membership-selection.ts';
import {
  type MembershipOperation,
  type MembershipState,
  membershipStateOf,
} from './membership-operations.ts';
import { nextEventSeq } from './stream.ts';
import { applyInvitePush, withdrawInvitePush } from './notifications.ts';
import type { PushPublication } from './push-project.ts';

export type MembershipEvidence = {
  event: SignatureEvidence;
  localLeave: SignatureEvidence | null;
  provenance: { event: boolean; localLeave: boolean };
};

/** A source join retires its imported OOB display, not the receiver's room
 * membership. Re-read selection and the exact import binding in the commit so
 * concurrent/local work cannot be erased by an earlier prepared observation. */
export async function withdrawCompletedMembershipDisplay(
  conn: Conn,
  semanticKey: string,
): Promise<void> {
  const selection = await membershipDisplay(conn, semanticKey, false);
  if (selection.display.length) return;
  const joined = selection.ready.map((operation) =>
    JSON.parse(operation.payload) as MembershipState
  ).filter((state) => state.status === 'joined');
  if (!joined.length) return;
  const { roomId, userId } = joined[0];
  const [previous] = await conn.query(
    'SELECT * FROM prejoin_memberships WHERE room_id=? AND user_id=?',
    [roomId, userId],
  );
  if (!previous || previous.source_binding == null) return;
  const binding = JSON.parse(String(previous.source_binding));
  if (
    canonicalJson(binding.state) !==
      canonicalJson(membershipStateOf(previous)) ||
    !Array.isArray(binding.operations) || !binding.operations.length ||
    !binding.operations.every((id: string) => {
      const retained = selection.ready.find((operation) =>
        operation.operationId === id
      );
      if (!retained) return false;
      const state = JSON.parse(retained.payload) as MembershipState;
      return selection.suppressed.has(state.eventId) ||
        !selection.frontier.some((operation) => operation.operationId === id);
    })
  ) return;
  await withdrawInvitePush(conn, userId, roomId, String(previous.event_id));
  await conn.execute(
    'DELETE FROM prejoin_memberships WHERE room_id=? AND user_id=?',
    [roomId, userId],
  );
  await conn.execute('DELETE FROM domain_frontiers WHERE semantic_key=?', [
    semanticKey,
  ]);
}

// Signature overlays and stripped hints enrich evidence for an existing event;
// they do not create another membership transition, position or push decision.
function publicationMaterial(state: Omit<MembershipState, 'publication'>) {
  const event = JSON.parse(state.eventJson) as Pdu;
  const departure = ['leave', 'ban'].includes(String(event.content?.membership))
    ? event
    : state.localLeaveJson === null
    ? null
    : JSON.parse(state.localLeaveJson) as Pdu;
  const displayed = state.status === 'pending' ? event : departure;
  return canonicalJson({
    roomId: state.roomId,
    userId: state.userId,
    roomVersion: state.roomVersion,
    eventId: displayed?.event_id ?? null,
    membership: displayed?.content?.membership ?? null,
  });
}

async function retainAcceptedEvent(
  accepted: Pdu,
  evidence: SignatureEvidence,
  hashRedacted: boolean,
): Promise<Pdu> {
  if (!await compatibleEventMaterial(accepted, evidence, hashRedacted)) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'membership changes a retained event',
    );
  }
  const pdu = structuredClone(accepted);
  for (const [server, entries] of Object.entries(evidence.signatures)) {
    for (const [key, signature] of Object.entries(entries)) {
      const prior = pdu.signatures?.[server]?.[key];
      if (prior !== undefined && prior <= signature) continue;
      pdu.signatures ??= {};
      Object.defineProperty(pdu.signatures, server, {
        value: { ...pdu.signatures[server], [key]: signature },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return pdu;
}

export async function materializeMembershipDisplay(
  conn: Conn,
  selected: MembershipOperation[],
  state: MembershipState,
  evidence: MembershipEvidence,
  publication: PushPublication,
  now: number,
): Promise<void> {
  const semanticKey = canonicalJson([
    'membership',
    state.roomId,
    state.userId,
  ]);
  const actual = (await membershipDisplay(conn, semanticKey, false)).display;
  if (
    !actual.length || canonicalJson(actual) !== canonicalJson(selected) ||
    actual.some((operation) => {
      const original = JSON.parse(operation.payload) as MembershipState;
      return original.eventId !== state.eventId ||
        original.roomVersion !== state.roomVersion ||
        original.kind !== state.kind || original.status !== state.status;
    })
  ) throw new Error('membership display selection changed');
  const [previous] = await conn.query(
    'SELECT * FROM prejoin_memberships WHERE room_id=? AND user_id=?',
    [state.roomId, state.userId],
  );
  const { publication: _sourcePublication, ...value } = state;
  const provenance = { ...evidence.provenance };
  if (previous) {
    const prior = membershipStateOf(previous);
    const binding = previous.source_binding == null
      ? null
      : JSON.parse(String(previous.source_binding));
    const priorProvenance = binding &&
        canonicalJson(binding.state) === canonicalJson(prior)
      ? binding.provenance
      : null;
    const event = JSON.parse(prior.eventJson) as Pdu;
    if (event.event_id === evidence.event.eventId) {
      value.eventJson = canonicalJson(
        await retainAcceptedEvent(
          event,
          evidence.event,
          priorProvenance?.event === true,
        ),
      );
      provenance.event = priorProvenance?.event === true;
    }
    if (prior.localLeaveJson !== null && evidence.localLeave !== null) {
      const leave = JSON.parse(prior.localLeaveJson) as Pdu;
      if (leave.event_id === evidence.localLeave.eventId) {
        value.localLeaveJson = canonicalJson(
          await retainAcceptedEvent(
            leave,
            evidence.localLeave,
            priorProvenance?.localLeave === true,
          ),
        );
        provenance.localLeave = priorProvenance?.localLeave === true;
      }
    }
  }
  const same = previous &&
    canonicalJson(membershipStateOf(previous)) === canonicalJson(value);
  if (!same) {
    const news = !previous ||
      publicationMaterial(membershipStateOf(previous)) !==
        publicationMaterial(value);
    if (previous && news) {
      await withdrawInvitePush(
        conn,
        state.userId,
        state.roomId,
        String(previous.event_id),
      );
    }
    const seq = news ? await nextEventSeq(conn) : Number(previous.seq);
    await conn.execute(
      `INSERT INTO prejoin_memberships(room_id,user_id,event_id,room_version,event_json,invite_room_state,origin,received_ms,status,seq,kind,local_leave_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(room_id,user_id) DO UPDATE SET event_id=excluded.event_id,
         room_version=excluded.room_version,event_json=excluded.event_json,
         invite_room_state=excluded.invite_room_state,origin=excluded.origin,
         received_ms=excluded.received_ms,status=excluded.status,seq=excluded.seq,
         kind=excluded.kind,revision=prejoin_memberships.revision+1,
         local_leave_json=excluded.local_leave_json,candidates='[]',
         expires_ms=NULL,leave_json=NULL`,
      [
        state.roomId,
        state.userId,
        state.eventId,
        state.roomVersion,
        value.eventJson,
        state.inviteRoomState,
        state.origin,
        news ? now : Number(previous.received_ms),
        state.status,
        seq,
        state.kind,
        value.localLeaveJson,
      ],
    );
    if (news && state.kind === 'invite' && state.status === 'pending') {
      await applyInvitePush(
        conn,
        state.roomId,
        state.eventId,
        seq,
        publication,
        now,
      );
    }
  }
  await bindMembershipDisplay(
    conn,
    state.roomId,
    state.userId,
    selected,
    provenance,
  );
}
