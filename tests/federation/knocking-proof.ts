import { assert, assertEquals, assertRejects } from '@std/assert';
import { startInstance } from '#tests/federation/instance.ts';
import { createRoom } from '#engine/room/create.ts';
import { membershipOf } from '#engine/room/membership.ts';
import { openRoom } from '#engine/room/index.ts';
import { knockRemote, performKnockAttempt } from '#engine/federation/knocks.ts';
import {
  inviteFor,
  inviteIntentProvider,
  inviteRemote,
  rejectInviteRemote,
  retryPrejoinIntents,
} from '#engine/federation/invites.ts';
import { makeKnock } from '#engine/federation/joins.ts';

// Explicit two-server proof: run in communico-5c on ark. Kept outside the
// CT-native *.test.ts glob to preserve the assigned execution boundary.
Deno.test('federated knock: signed ambiguous attempts reconcile, invite wins old revisions, retraction is durable', async () => {
  const resident = await startInstance();
  const guest = await startInstance();
  try {
    await resident.sender.stop();
    await guest.sender.stop();
    const user = '@knocker:' + guest.name;
    const owner = '@owner:' + resident.name;
    const made = await createRoom(resident.store, {
      creator: owner,
      version: '12',
      initial_state: [{
        type: 'm.room.join_rules',
        state_key: '',
        content: { join_rule: 'knock' },
      }],
    }, resident.signer);
    const roomId = made.roomId;
    const held = await openRoom(resident.store, roomId);
    // Fail the prejoin create validation after send_knock was accepted. The
    // same signed event must survive and reconcile rather than disappear.
    const lost = {
      ...guest.inviteDeps,
      keys: { verifyEventSignature: () => Promise.resolve(false) },
    };
    await assertRejects(() =>
      knockRemote(roomId, user, { reason: 'first' }, [resident.name], lost)
    );
    const attempt = await inviteFor(roomId, user, guest.inviteDeps);
    assert(attempt !== null);
    assertEquals([attempt.kind, attempt.status], ['knock', 'attempting']);
    assertEquals((await membershipOf(held, user))?.membership, 'knock');
    await assertRejects(
      () => openRoom(guest.store, roomId),
      Deno.errors.NotFound,
    );
    const provider = inviteIntentProvider(guest.inviteDeps);
    const job = await provider(guest.server, resident.name);
    assert(job !== null);
    await job.run();
    const confirmed = await inviteFor(roomId, user, guest.inviteDeps);
    assertEquals([confirmed?.status, confirmed?.eventId], [
      'pending',
      attempt.eventId,
    ]);
    assertEquals((await membershipOf(held, user))?.eventId, attempt.eventId);
    const display = JSON.parse(confirmed!.inviteRoomState);
    assert(
      display.some((e: Record<string, unknown>) => e.type === 'm.room.create'),
    );
    assert(
      display.every((e: Record<string, unknown>) => e.signatures === undefined),
    );
    await knockRemote(
      roomId,
      user,
      { reason: 'second' },
      [resident.name],
      guest.inviteDeps,
    );
    const repeated = await inviteFor(roomId, user, guest.inviteDeps);
    assert(repeated!.revision > attempt.revision);
    assertEquals(JSON.parse(repeated!.eventJson).content.reason, 'second');
    await inviteRemote(
      roomId,
      owner,
      user,
      undefined,
      undefined,
      resident.inviteDeps,
    );
    const invited = await inviteFor(roomId, user, guest.inviteDeps);
    assertEquals([invited?.kind, invited?.status], ['invite', 'pending']);
    await performKnockAttempt(attempt, guest.inviteDeps);
    assertEquals(await inviteFor(roomId, user, guest.inviteDeps), invited);
    assertEquals((await membershipOf(held, user))?.membership, 'invite');
    // Rejecting the invitation retains the existing unbounded invite lifetime.
    await rejectInviteRemote(roomId, user, guest.inviteDeps);
    assertEquals(
      (await inviteFor(roomId, user, guest.inviteDeps))?.expiresMs,
      null,
    );
    const reject = await provider(guest.server, resident.name);
    assert(reject !== null);
    await reject.run();
    await knockRemote(
      roomId,
      user,
      { reason: 'third' },
      [resident.name],
      guest.inviteDeps,
    );
    await rejectInviteRemote(roomId, user, guest.inviteDeps);
    const retract = await inviteFor(roomId, user, guest.inviteDeps);
    assertEquals(retract?.kind, 'knock');
    assert(retract!.expiresMs !== null);
    const restarted = inviteIntentProvider(guest.inviteDeps);
    const leave = await restarted(guest.server, resident.name);
    assert(leave !== null);
    await leave.run();
    assertEquals((await membershipOf(held, user))?.membership, 'leave');
    assertEquals(
      (await inviteFor(roomId, user, guest.inviteDeps))?.status,
      'rejected',
    );
    await assertRejects(
      () => openRoom(guest.store, roomId),
      Deno.errors.NotFound,
    );
  } finally {
    await guest.close();
    await resident.close();
  }
});

Deno.test('knock expiry stays reviewable, explicit retry reconciles and old retraction cannot erase a new invite', async () => {
  const resident = await startInstance();
  const guest = await startInstance();
  try {
    await resident.sender.stop();
    await guest.sender.stop();
    const owner = '@owner:' + resident.name;
    const user = '@guest:' + guest.name;
    const { roomId } = await createRoom(resident.store, {
      creator: owner,
      version: '12',
      initial_state: [{
        type: 'm.room.join_rules',
        state_key: '',
        content: { join_rule: 'knock' },
      }],
    }, resident.signer);
    await assertRejects(() =>
      knockRemote(roomId, user, {}, [resident.name], {
        ...guest.inviteDeps,
        keys: { verifyEventSignature: () => Promise.resolve(false) },
      })
    );
    await guest.server.execute(
      'UPDATE prejoin_memberships SET expires_ms=0 WHERE room_id=?',
      [roomId],
    );
    const provider = inviteIntentProvider(guest.inviteDeps);
    assertEquals(await provider(guest.server, resident.name), null);
    assertEquals(
      (await inviteFor(roomId, user, guest.inviteDeps))?.status,
      'failed-attempt',
    );
    assertEquals((await provider.review()).length, 1);
    await retryPrejoinIntents(guest.server, guest.name, resident.name);
    const retry = await provider(guest.server, resident.name);
    assert(retry !== null);
    await retry.run();
    assertEquals(
      (await inviteFor(roomId, user, guest.inviteDeps))?.status,
      'pending',
    );
    await rejectInviteRemote(roomId, user, guest.inviteDeps);
    const oldLeave = await provider(guest.server, resident.name);
    assert(oldLeave !== null);
    await inviteRemote(
      roomId,
      owner,
      user,
      undefined,
      undefined,
      resident.inviteDeps,
    );
    const invited = await inviteFor(roomId, user, guest.inviteDeps);
    await oldLeave.run();
    assertEquals(await inviteFor(roomId, user, guest.inviteDeps), invited);
    const room = await openRoom(resident.store, roomId);
    assertEquals((await membershipOf(room, user))?.membership, 'invite');
  } finally {
    await guest.close();
    await resident.close();
  }
});

Deno.test('make_knock negotiates knock-capable versions and refuses ordinary private rooms', async () => {
  const resident = await startInstance();
  try {
    const user = '@knocker:remote.test';
    for (const version of ['6', '7', '10', '12']) {
      const made = await createRoom(resident.store, {
        creator: '@owner:' + resident.name,
        version,
        initial_state: [{
          type: 'm.room.join_rules',
          state_key: '',
          content: { join_rule: 'knock' },
        }],
      }, resident.signer);
      if (version === '6') {
        await assertRejects(() =>
          makeKnock(
            made.roomId,
            user,
            'remote.test',
            [version],
            resident.inviteDeps,
          )
        );
      } else {assertEquals(
          (await makeKnock(
            made.roomId,
            user,
            'remote.test',
            [version],
            resident.inviteDeps,
          )).room_version,
          version,
        );}
      await assertRejects(() =>
        makeKnock(made.roomId, user, 'remote.test', [], resident.inviteDeps)
      );
      await assertRejects(() =>
        makeKnock(
          made.roomId,
          user,
          'wrong.test',
          [version],
          resident.inviteDeps,
        )
      );
    }
  } finally {
    await resident.close();
  }
});
