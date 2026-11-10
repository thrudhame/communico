import { config } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { finalizeBuilt } from '#engine/room/build.ts';
import { assertKnownJoinEncryption } from '#engine/room/encryption-policy.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { admitLocalJoin } from '#engine/room/hooks.ts';
import { getRulebook, supportedRoomVersions } from '#engine/rulebook/index.ts';
import { withProjectionLock } from '#engine/server/project.ts';
import { eventStreamTx, nextEventSeq } from '#engine/server/stream.ts';
import { federationRequest } from './client.ts';
import { assertRoomAcl } from './acl.ts';
import { admit } from './gate.ts';
import { type InviteDeps, inviteFor, type StoredInvite } from './invites.ts';
import { toWire } from './pdu.ts';
import { validatePrejoin } from './prejoin.ts';
import { visiblePrejoin } from '#engine/server/prejoin.ts';

// A signed attempt is durable BEFORE send_knock. Retry the exact same event,
// never a reconstructed knock whose new ID could resurrect an old request.
export async function performKnockAttempt(
  attempt: StoredInvite,
  deps: InviteDeps,
): Promise<void> {
  const current = await inviteFor(attempt.roomId, attempt.userId, deps);
  if (
    current?.revision !== attempt.revision || current.status !== 'attempting' ||
    await deps.store.roomRetired(attempt.roomId)
  ) return;
  const pdu = JSON.parse(attempt.eventJson) as Pdu;
  const answer = await federationRequest(deps.server, deps.signer, {
    room: { store: deps.store, id: attempt.roomId, participation: true },
    destination: attempt.origin,
    method: 'PUT',
    path: `/_matrix/federation/v1/send_knock/${
      encodeURIComponent(attempt.roomId)
    }/${encodeURIComponent(attempt.eventId)}`,
    body: new TextEncoder().encode(
      JSON.stringify(toWire(pdu, attempt.roomVersion)),
    ),
  });
  const stripped = await validatePrejoin(
    (answer.json as Record<string, unknown>).knock_room_state,
    attempt.roomId,
    attempt.roomVersion,
    deps.keys,
  );
  await withRoomLock(attempt.roomId, () =>
    withProjectionLock(async () => {
      if (await deps.store.roomRetired(attempt.roomId)) return;
      await assertRoomAcl(deps.store, attempt.roomId, deps.self);
      await eventStreamTx(deps.server, async (tx) => {
        const rows = await tx.query(
          `SELECT 1 FROM prejoin_memberships p WHERE room_id=? AND user_id=? AND revision=? AND status='attempting' AND ${
            visiblePrejoin('p')
          }`,
          [attempt.roomId, attempt.userId, attempt.revision],
        );
        if (!rows.length) return;
        await tx.execute(
          "UPDATE prejoin_memberships SET status='pending', invite_room_state=?, seq=?, expires_ms=NULL WHERE room_id=? AND user_id=? AND revision=?",
          [
            JSON.stringify(stripped),
            await nextEventSeq(tx),
            attempt.roomId,
            attempt.userId,
            attempt.revision,
          ],
        );
      });
    }));
}

export async function knockRemote(
  roomId: string,
  userId: string,
  content: Record<string, unknown>,
  via: string[],
  deps: InviteDeps,
) {
  await assertKnownJoinEncryption(deps.store, roomId);
  await assertRoomAcl(deps.store, roomId, deps.self);
  const previous = await inviteFor(roomId, userId, deps);
  if (
    previous !== null &&
    ['attempting', 'rejecting', 'failed-retract'].includes(previous.status)
  ) {
    throw new MatrixError(
      409,
      'M_BAD_STATE',
      'remote participation reconciliation is pending',
    );
  }
  if (previous?.kind === 'invite' && previous.status === 'pending') {
    throw new MatrixError(403, 'M_FORBIDDEN', 'already invited');
  }
  let last: unknown = new MatrixError(
    404,
    'M_NOT_FOUND',
    'no servers to knock through',
  );
  for (const destination of via.slice(0, 8)) {
    try {
      await admit(deps.server, destination, {
        kind: 'outbound',
        user: userId,
        what: 'knock',
      });
      const versions = supportedRoomVersions().filter((v) =>
        getRulebook(v).spec.knockJoinRule
      );
      const made = await federationRequest(deps.server, deps.signer, {
        room: { store: deps.store, id: roomId, participation: true },
        destination,
        method: 'GET',
        path:
          `/_matrix/federation/v1/make_knock/${encodeURIComponent(roomId)}/${
            encodeURIComponent(userId)
          }?` + versions.map((v) => 'ver=' + v).join('&'),
        body: null,
      });
      const { room_version: version, event } = made.json as {
        room_version?: unknown;
        event?: Pdu;
      };
      if (
        typeof version !== 'string' || !versions.includes(version) ||
        event === undefined || event.type !== 'm.room.member' ||
        event.room_id !== roomId || event.sender !== userId ||
        event.state_key !== userId || event.content?.membership !== 'knock' ||
        !Array.isArray(event.prev_events) ||
        !Array.isArray(event.auth_events) || !Number.isSafeInteger(event.depth)
      ) {
        throw new MatrixError(502, 'M_BAD_JSON', 'invalid make_knock template');
      }
      const pdu = await finalizeBuilt(
        {
          ...event,
          content: { ...content, membership: 'knock' },
          origin_server_ts: Date.now(),
          signatures: {},
          hashes: { sha256: '' },
        },
        getRulebook(version),
        deps.signer,
      );
      const attempt = await withRoomLock(
        roomId,
        () =>
          withProjectionLock(async () => {
            await admitLocalJoin(deps.store, roomId, userId);
            if (await deps.store.roomRetired(roomId)) {
              throw new MatrixError(
                404,
                'M_NOT_FOUND',
                'room removal is pending',
              );
            }
            return await eventStreamTx(deps.server, async (tx) => {
              const rows = await tx.query(
                'SELECT revision FROM prejoin_memberships WHERE room_id=? AND user_id=?',
                [roomId, userId],
              );
              if (
                Number(rows[0]?.revision == null ? 0 : rows[0].revision) !==
                  (previous == null ? 0 : previous.revision)
              ) {
                throw new MatrixError(
                  409,
                  'M_BAD_STATE',
                  'membership changed during knock',
                );
              }
              const authoritative = await tx.query(
                "SELECT 1 FROM memberships WHERE room=? AND user=? AND membership IN ('join','invite','ban') AND seq>?",
                [roomId, userId, previous == null ? 0 : previous.seq],
              );
              if (authoritative.length) {
                throw new MatrixError(
                  409,
                  'M_BAD_STATE',
                  'membership changed during knock',
                );
              }
              const revision = (previous == null ? 0 : previous.revision) + 1;
              const now = Date.now();
              const seq = await nextEventSeq(tx);
              const expires = now +
                config().federation.refusedmillihours * 3600;
              await tx.execute(
                `INSERT INTO prejoin_memberships(room_id,user_id,event_id,room_version,event_json,invite_room_state,origin,received_ms,status,seq,kind,revision,candidates,expires_ms)
            VALUES(?,?,?,?,?,'[]',?,?,'attempting',?,'knock',?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET event_id=excluded.event_id,room_version=excluded.room_version,event_json=excluded.event_json,invite_room_state='[]',origin=excluded.origin,received_ms=excluded.received_ms,status='attempting',seq=excluded.seq,kind='knock',revision=excluded.revision,candidates=excluded.candidates,leave_json=NULL,expires_ms=excluded.expires_ms`,
                [
                  roomId,
                  userId,
                  String(pdu.event_id),
                  version,
                  JSON.stringify(pdu),
                  destination,
                  now,
                  seq,
                  revision,
                  JSON.stringify(via),
                  expires,
                ],
              );
              return {
                roomId,
                userId,
                eventId: String(pdu.event_id),
                roomVersion: version,
                eventJson: JSON.stringify(pdu),
                inviteRoomState: '[]',
                origin: destination,
                receivedMs: now,
                status: 'attempting',
                seq,
                kind: 'knock',
                revision,
                candidates: via,
                expiresMs: expires,
                leaveJson: null,
              } satisfies StoredInvite;
            });
          }),
      );
      try {
        await performKnockAttempt(attempt, deps);
      } catch (error) {
        // The receiver may have accepted it. Keep the journal, retry the same
        // signed event after restart, and never fail over to another send.
        deps.wake(destination);
        throw error;
      }
      return { roomId, eventId: attempt.eventId, created: true };
    } catch (error) {
      last = error;
      const held = await inviteFor(roomId, userId, deps);
      if (held?.revision !== previous?.revision && held !== null) throw error;
      const status = (error as { status?: number }).status;
      if (status === 403 || status === 409) throw error;
    }
  }
  throw last;
}
