// tests/federation-loop.test.ts — the multi-instance cases (plan §6):
// two in-process communico instances (separate stores, loopback HTTPS,
// test certs/keys) federating with each other — no counterpart servers.
// A creates a room, invites B's user over federation, B accepts
// (joinRemote), both exchange messages, both rooms converge (same
// events, same current state). A offline → B's outbox retries with
// backoff, delivers after A returns (sender restart resumes the pending
// rows), no duplicates (the txn cache answers a repeated transaction).
// A blocked origin refuses B's sends until unblocked.
import { assert, assertEquals } from '@std/assert';
import { addBlock, removeBlock } from '#engine/federation/peers.ts';
import {
  inviteFor,
  inviteJoinCandidates,
  inviteRemote,
  markInviteJoined,
  rejectInviteRemote,
} from '#engine/federation/invites.ts';
import { listOutbox, peerStatus } from '#engine/federation/sender.ts';
import { receiveTransaction } from '#engine/federation/transactions.ts';
import { createRoom } from '#engine/room/create.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { openRoom, type Room } from '#engine/room/index.ts';
import { joinRemote } from '#engine/room/join.ts';
import { membershipOf } from '#engine/server/read.ts';
import { type Instance, startInstance } from './federation/instance.ts';

async function waitFor(
  what: () => Promise<boolean> | boolean,
  ms = 20000,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await what()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

type Digest = { state: Record<string, string>; events: string[] };

async function roomDigest(room: Room): Promise<Digest> {
  return await room.tx(async (tx) => {
    const stay = await tx.segments.openStay();
    const group = stay === null ? null : await tx.state.current(stay.id);
    const map = group === null
      ? new Map<string, string>()
      : await tx.state.groupMap(group);
    const changes = await tx.changes.after(0, 100000);
    const events = [
      ...new Set(
        changes.map((c) => c.event).filter((e): e is string => e !== null),
      ),
    ].sort();
    return { state: Object.fromEntries(map), events };
  });
}

async function say(
  instance: Instance,
  roomId: string,
  sender: string,
  body: string,
): Promise<string> {
  const room = await openRoom(instance.store, roomId);
  const res = await sendLocal(room, {
    type: 'm.room.message',
    sender,
    content: { msgtype: 'm.text', body },
    origin_server_ts: Date.now(),
  }, instance.signer);
  return res.eventId;
}

async function hasEvent(room: Room, eventId: string): Promise<boolean> {
  return await room.tx(async (tx) => (await tx.events.get(eventId)) !== null);
}

// The shared setup: A's room, B invited over federation, B accepts.
async function federatedRoom(
  a: Instance,
  b: Instance,
): Promise<{ roomId: string }> {
  const created = await createRoom(a.store, {
    creator: '@dev:' + a.name,
    preset: 'private_chat',
  }, a.signer);
  const roomId = created.roomId;
  await inviteRemote(
    roomId,
    '@dev:' + a.name,
    '@bob:' + b.name,
    undefined,
    undefined,
    a.inviteDeps,
  );
  // B sees the invite (the out-of-band row) and accepts through the
  // inviter first (§3.6 step 2)
  const invite = await inviteFor(roomId, '@bob:' + b.name, b.inviteDeps);
  assert(invite !== null, 'the invite reached B');
  assertEquals(invite.status, 'pending');
  const candidates = await inviteJoinCandidates(
    roomId,
    '@bob:' + b.name,
    b.inviteDeps,
  );
  assertEquals(candidates[0], a.name, 'the inviter is the first candidate');
  const deps = b.remoteDeps();
  await joinRemote(b.store, {
    roomId,
    user: '@bob:' + b.name,
    via: candidates,
    signer: b.signer,
    deps: { keys: deps.keys, fetcher: deps.fetcher, self: deps.self },
  });
  await markInviteJoined(roomId, '@bob:' + b.name, b.inviteDeps);
  assertEquals(
    (await inviteFor(roomId, '@bob:' + b.name, b.inviteDeps))?.status,
    'joined',
  );
  return { roomId };
}

Deno.test('loop: invite → accept → both exchange messages → the rooms converge', async () => {
  const a = await startInstance();
  const b = await startInstance();
  try {
    const { roomId } = await federatedRoom(a, b);
    // A's side learned the join (the send_join handler ingested it)
    const aRoom = await openRoom(a.store, roomId);
    const bRoom = await openRoom(b.store, roomId);
    const joinOnA = await membershipOf(a.server, roomId, '@bob:' + b.name);
    assertEquals(joinOnA?.membership, 'join');
    // both exchange messages
    const m1 = await say(a, roomId, '@dev:' + a.name, 'hello from A');
    const m2 = await say(b, roomId, '@bob:' + b.name, 'hello from B');
    const m3 = await say(a, roomId, '@dev:' + a.name, 'second from A');
    await waitFor(() => hasEvent(bRoom, m3));
    await waitFor(() => hasEvent(aRoom, m2));
    await waitFor(() => hasEvent(bRoom, m1));
    // convergence: same events, same current state
    const da = await roomDigest(aRoom);
    const db = await roomDigest(bRoom);
    assertEquals(db.events, da.events);
    assertEquals(db.state, da.state);
    // nothing left undelivered either way (the sent marks trail the
    // receiver's ingest by a tick)
    await waitFor(
      async () =>
        (await listOutbox(a.server)).every((r) => r.state !== 'pending'),
    );
    await waitFor(
      async () =>
        (await listOutbox(b.server)).every((r) => r.state !== 'pending'),
    );
  } finally {
    await a.close();
    await b.close();
  }
});

Deno.test('loop: A offline → B retries with backoff, a B restart resumes the pending rows, delivery after A returns — no duplicates (txn cache)', async () => {
  const a = await startInstance();
  const b = await startInstance();
  try {
    const { roomId } = await federatedRoom(a, b);
    const aRoom = await openRoom(a.store, roomId);
    const bRoom = await openRoom(b.store, roomId);
    // A goes offline (its listener and its own sender)
    await a.stopNet();
    await a.sender.stop();
    // B keeps talking: two messages queue in B's outbox
    const m1 = await say(b, roomId, '@bob:' + b.name, 'A is down 1');
    const m2 = await say(b, roomId, '@bob:' + b.name, 'A is down 2');
    // B exhausts its 4/16-second transaction retry group before publishing
    // a durable failure. Observe that phase, not a pre-retry 10-second bound.
    await waitFor(
      async () => (await peerStatus(b.server, a.name)).failures >= 1,
      30000,
    );
    const st = await peerStatus(b.server, a.name);
    assert(st.unreachableSinceMs !== null);
    assert(st.nextAttemptMs > Date.now(), 'backing off');
    assertEquals(await hasEvent(aRoom, m1), false);
    // B restarts its sender: the resume scan picks the pending rows up
    // (and keeps failing while A is down)
    await b.restartSender();
    await waitFor(
      async () => (await peerStatus(b.server, a.name)).attemptsTotal >= 2,
      30000,
    );
    // A returns — the ladder fires (a tiny rung) and the batch delivers
    await a.startNet();
    await waitFor(() => hasEvent(aRoom, m1));
    await waitFor(() => hasEvent(aRoom, m2));
    // exactly once each
    const digest = await roomDigest(aRoom);
    assertEquals(digest.events.filter((e) => e === m1).length, 1);
    assertEquals(digest.events.filter((e) => e === m2).length, 1);
    await waitFor(
      async () =>
        (await listOutbox(b.server, a.name)).every((r) =>
          r.state !== 'pending'
        ),
    );
    // a repeated transaction id gets the cached answer — no re-processing
    const recorded = a.receivedTxns[a.receivedTxns.length - 1];
    const before = (await roomDigest(aRoom)).events.length;
    const deps = a.remoteDeps();
    const again = await receiveTransaction(
      recorded.origin,
      recorded.txnId,
      recorded.body,
      {
        store: a.store,
        keys: deps.keys,
        fetcher: deps.fetcher,
        self: a.name,
        edus: a.edus,
      },
    );
    assertEquals(again.status, 200);
    assertEquals((await roomDigest(aRoom)).events.length, before);
    // convergence after the dust settles
    const db = await roomDigest(bRoom);
    const da = await roomDigest(aRoom);
    assertEquals(db.events, da.events);
    assertEquals(db.state, da.state);
  } finally {
    await a.close();
    await b.close();
  }
});

Deno.test('loop: a blocked origin is refused until unblocked', async () => {
  const a = await startInstance();
  const b = await startInstance();
  try {
    const { roomId } = await federatedRoom(a, b);
    const aRoom = await openRoom(a.store, roomId);
    // A blocks B
    await addBlock(a.server, b.name, 'test block');
    const m1 = await say(b, roomId, '@bob:' + b.name, 'blocked hello');
    // B's sender gets the 403 and writes the refused entry; the row stays
    await waitFor(async () => {
      const rows = await b.server.query(
        "SELECT detail FROM federation_pending WHERE name = ? AND kind = 'refused'",
        [a.name],
      );
      return rows.length > 0;
    }, 10000);
    assertEquals(await hasEvent(aRoom, m1), false);
    assert(
      (await listOutbox(b.server, a.name)).some((r) => r.state === 'pending'),
      'the row waits for the operator',
    );
    // unblock: delivery resumes
    await removeBlock(a.server, b.name);
    await waitFor(() => hasEvent(aRoom, m1));
    const db = await roomDigest(await openRoom(b.store, roomId));
    const da = await roomDigest(aRoom);
    assertEquals(db.events, da.events);
    assertEquals(db.state, da.state);
  } finally {
    await a.close();
    await b.close();
  }
});

Deno.test('loop: B rejects A’s invite — the dance performs make/send_leave against A', async () => {
  const a = await startInstance();
  const b = await startInstance();
  try {
    const created = await createRoom(a.store, {
      creator: '@dev:' + a.name,
      preset: 'private_chat',
    }, a.signer);
    const roomId = created.roomId;
    await inviteRemote(
      roomId,
      '@dev:' + a.name,
      '@bob:' + b.name,
      undefined,
      undefined,
      a.inviteDeps,
    );
    const invite = await inviteFor(roomId, '@bob:' + b.name, b.inviteDeps);
    assert(invite !== null);
    // B rejects: local effect at once, then the dance against A
    await rejectInviteRemote(roomId, '@bob:' + b.name, b.inviteDeps);
    assertEquals(
      (await inviteFor(roomId, '@bob:' + b.name, b.inviteDeps))?.status,
      'rejecting',
    );
    await waitFor(async () =>
      (await inviteFor(roomId, '@bob:' + b.name, b.inviteDeps))?.status ===
        'rejected'
    );
    // the leave landed on A's room (the invited user leaves the invite)
    const membership = await membershipOf(a.server, roomId, '@bob:' + b.name);
    assertEquals(membership?.membership, 'leave');
    // and B's rendered event is the signed leave
    const row = await inviteFor(roomId, '@bob:' + b.name, b.inviteDeps);
    const rendered = JSON.parse(row!.eventJson) as Record<string, unknown>;
    assertEquals(
      (rendered.content as Record<string, unknown>).membership,
      'leave',
    );
  } finally {
    await a.close();
    await b.close();
  }
});
