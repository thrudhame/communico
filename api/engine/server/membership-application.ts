// Materialization owns receiver-local publication, never foreign work or source
// authorship. The link adapter supplies verified, normalized selected evidence.
import { canonicalJson } from '#engine/canonical.ts';
import { eventMaterial } from '#engine/room/verify.ts';
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

// Signature overlays and stripped hints enrich evidence for an existing event;
// they do not create another membership transition, position or push decision.
function publicationMaterial(state: Omit<MembershipState, 'publication'>) {
  return canonicalJson({
    ...state,
    inviteRoomState: null,
    eventJson: eventMaterial(JSON.parse(state.eventJson) as Pdu),
    localLeaveJson: state.localLeaveJson === null
      ? null
      : eventMaterial(JSON.parse(state.localLeaveJson) as Pdu),
  });
}

export async function materializeMembershipDisplay(
  conn: Conn,
  selected: MembershipOperation[],
  state: MembershipState,
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
        state.eventJson,
        state.inviteRoomState,
        state.origin,
        news ? now : Number(previous.received_ms),
        state.status,
        seq,
        state.kind,
        state.localLeaveJson,
      ],
    );
    if (news && state.kind === 'invite') {
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
  );
}
