import { assert, assertEquals } from '@std/assert';
import { startHttp } from '#tests/http-app.ts';
import {
  acceptRescind,
  type InviteDeps,
  markInviteJoined,
  receiveInvite,
  rejectInviteRemote,
} from '#engine/federation/invites.ts';
import {
  notificationSnapshot,
  roomNotificationCounts,
} from '#engine/server/notifications.ts';
import { setRuleEnabled } from '#engine/tenant/pushrules.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
  wireOf,
} from '#tests/fixtures/remote.ts';
import { makeFakeRoom } from '#tests/fixtures/remote-room.ts';
import { openRoom } from '#engine/room/index.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { ingestInTx } from '#engine/room/ingest.ts';
import { verify } from '#engine/room/verify.ts';
import { stripPrejoin } from '#engine/federation/prejoin.ts';

Deno.test('push invites: accepted OOB invites count once, replace and withdraw atomically without room files', async () => {
  const http = await startHttp();
  try {
    const { app } = http;
    const user = await http.registerTestUser('push-invite', 'pw');
    const remote = await makeRemoteServer('remote.test');
    const deps: InviteDeps = {
      store: app.store,
      server: app.server,
      signer: app.tenant.signer(),
      self: app.tenant.serverName,
      keys: fakeKeyResolver(remote),
      wake: () => {},
    };
    const room = '!push-oob:remote.test';
    const make = (suffix: string) =>
      remoteEvent(room, remote, '11', {
        type: 'm.room.member',
        sender: '@zoe:remote.test',
        state_key: user.user_id,
        content: { membership: 'invite' },
        prev_events: ['$' + suffix],
        auth_events: [],
      });
    const receive = async (event: Awaited<ReturnType<typeof make>>) => {
      await receiveInvite(
        room,
        event.event_id!,
        {
          room_version: '11',
          event: wireOf(event),
          invite_room_state: [],
        },
        remote.name,
        deps,
      );
    };
    const count = () =>
      app.server.tx(async (tx) => {
        const snapshot = await notificationSnapshot(tx, user.user_id, 0);
        return roomNotificationCounts(snapshot.rooms.get(room));
      });
    const first = await make('one');
    await receive(first);
    const history = async () => {
      const response = await http.matrix(
        new Request('http://x/_matrix/client/v3/notifications', {
          headers: { Authorization: 'Bearer ' + user.access_token },
        }),
      );
      assertEquals(response.status, 200);
      return (await response.json()).notifications as Record<string, unknown>[];
    };
    const listed = await history();
    assertEquals(listed.length, 1);
    assertEquals(
      (listed[0].event as Record<string, unknown>).event_id,
      first.event_id,
    );
    assertEquals(
      (listed[0].event as Record<string, unknown>).room_id,
      undefined,
    );
    assertEquals(
      (listed[0].event as Record<string, unknown>).signatures,
      undefined,
    );
    assertEquals(listed[0].room_id, room);
    assertEquals(await count(), { notification_count: 1, highlight_count: 0 });
    const sync = await http.matrix(
      new Request('http://x/_matrix/client/v3/sync', {
        headers: { Authorization: 'Bearer ' + user.access_token },
      }),
    );
    const body = await sync.json();
    assert(body.rooms.invite[room]);
    const cut = (await app.server.query(
      'SELECT seq FROM prejoin_memberships WHERE room_id=?',
      [room],
    ))[0].seq;
    await receive(first);
    assertEquals(await count(), { notification_count: 1, highlight_count: 0 });
    assertEquals(
      (await app.server.query(
        'SELECT seq FROM prejoin_memberships WHERE room_id=?',
        [room],
      ))[0].seq,
      cut,
    );
    const second = await make('two');
    await receive(second);
    assertEquals(
      (await history()).map((n) =>
        (n.event as Record<string, unknown>).event_id
      ),
      [second.event_id],
    );
    assertEquals(await count(), { notification_count: 1, highlight_count: 0 });
    await receive(first);
    assertEquals(
      (await app.server.query(
        'SELECT event_id FROM prejoin_memberships WHERE room_id=?',
        [room],
      ))[0].event_id,
      second.event_id,
      'replaying a replaced invite cannot withdraw or replace its successor',
    );
    assertEquals(
      (await app.server.query(
        'SELECT withdrawn FROM notifications WHERE event=?',
        [first.event_id!],
      ))[0].withdrawn,
      1,
    );
    await rejectInviteRemote(room, user.user_id, deps);
    assertEquals(await history(), []);
    assertEquals(await count(), { notification_count: 0, highlight_count: 0 });
    // Duplicate federation traffic after a local rejection cannot resurrect it.
    await receive(second);
    assertEquals(await count(), { notification_count: 0, highlight_count: 0 });
    const third = await make('three');
    await receive(third);
    assertEquals(await count(), { notification_count: 1, highlight_count: 0 });
    await markInviteJoined(room, user.user_id, deps);
    assertEquals(await count(), { notification_count: 0, highlight_count: 0 });
    const fourth = await make('four');
    await receive(fourth);
    assert(
      await acceptRescind(
        room,
        { ...fourth, content: { membership: 'leave' } },
        deps,
      ),
    );
    assertEquals(await count(), { notification_count: 0, highlight_count: 0 });
    // Tenant rules apply at publication, using the same rule owner as held rooms.
    await setRuleEnabled(
      app.tenant,
      'push-invite',
      'override',
      '.m.rule.master',
      true,
    );
    await receive(await make('five'));
    assertEquals(await count(), { notification_count: 0, highlight_count: 0 });
    assertEquals(await app.store.rooms(), []);
    assertEquals(
      (await app.server.query(
        'SELECT COUNT(*) AS n FROM push_evaluations WHERE user=?',
        [user.user_id],
      ))[0].n,
      5,
    );
  } finally {
    await http.close();
  }
});

Deno.test('push invites: later held-room publication deduplicates the same OOB event', async () => {
  const http = await startHttp();
  try {
    const { app } = http;
    const user = await http.registerTestUser('push-held-invite', 'pw');
    const fake = await makeFakeRoom({ roomId: '!push-held:remote.test' });
    const invite = await fake.addEvent({
      type: 'm.room.member',
      state_key: user.user_id,
      content: { membership: 'invite' },
    });
    const keys = fakeKeyResolver(fake.server);
    await receiveInvite(
      fake.roomId,
      invite.event_id!,
      {
        room_version: '11',
        event: wireOf(invite),
        invite_room_state: [],
      },
      fake.server.name,
      {
        store: app.store,
        server: app.server,
        signer: app.tenant.signer(),
        self: app.tenant.serverName,
        keys,
        wake: () => {},
      },
    );
    const room = await openRoom(app.store, fake.roomId, { create: true });
    const events = [...fake.events.values()];
    const create = await verify(events[0], fake.version, keys, {
      roomId: fake.roomId,
    });
    await room.tx(async (tx) => {
      const group = await tx.materialize.newGroup(null, []);
      await tx.segments.create({ kind: 'stay', opening_group: group });
      const result = await ingestInTx(tx, fake.roomId, create.pdu, {
        remote: {
          origin: fake.server.name,
          self: app.tenant.serverName,
          oversized: create.oversized,
          ungroundedMs: 3_600_000,
        },
      });
      assertEquals(result.standing, 'accepted');
    });
    const result = await ingestRemote(
      room,
      events.slice(1),
      fake.server.name,
      {
        keys,
        self: app.tenant.serverName,
        fetcher: fakeFetcher({}).fetcher,
        limits: { waitMs: 0, limit: 20, budgetMs: 8000 },
        ungroundedMs: 3_600_000,
      },
    );
    assert(result.every((r) => r.outcome === 'accepted'));
    const snapshot = await app.server.tx((tx) =>
      notificationSnapshot(tx, user.user_id, 0)
    );
    assertEquals(roomNotificationCounts(snapshot.rooms.get(fake.roomId)), {
      notification_count: 1,
      highlight_count: 0,
    });
    assertEquals(
      (await app.server.query(
        'SELECT COUNT(*) AS n FROM notifications WHERE user=? AND event=?',
        [user.user_id, invite.event_id!],
      ))[0].n,
      1,
    );
    assertEquals(
      (await app.server.query('SELECT COUNT(*) AS n FROM feed WHERE event=?', [
        invite.event_id!,
      ]))[0].n,
      1,
    );
  } finally {
    await http.close();
  }
});

Deno.test('saved OOB hints cannot bypass known held-room redactions in notification and sync display', async () => {
  const http = await startHttp();
  try {
    const { app } = http;
    const user = await http.registerTestUser('push-hint-redaction', 'pw');
    const get = async (path: string) => {
      const response = await http.matrix(
        new Request('http://x/_matrix/client/v3/' + path, {
          headers: { Authorization: 'Bearer ' + user.access_token },
        }),
      );
      assertEquals(response.status, 200);
      return await response.json();
    };
    for (const full of [true, false]) {
      const fake = await makeFakeRoom({
        roomId: '!hint-' + full + ':remote.test',
      });
      const name = await fake.addEvent({
        type: 'm.room.name',
        state_key: '',
        content: { name: 'private name' },
      });
      const topic = await fake.addEvent({
        type: 'm.room.topic',
        state_key: '',
        content: { topic: 'retained topic' },
      });
      const beforeInvite = [...fake.events.values()];
      const invite = await fake.addEvent({
        type: 'm.room.member',
        state_key: user.user_id,
        content: { membership: 'invite' },
      });
      const keys = fakeKeyResolver(fake.server);
      const hints = [fake.events.get(fake.createId)!, name, topic].map(wireOf);
      await receiveInvite(
        fake.roomId,
        invite.event_id!,
        {
          room_version: '11',
          event: wireOf(invite),
          invite_room_state: full
            ? hints
            : hints.map((e) =>
              stripPrejoin(e as unknown as Record<string, unknown>)
            ),
        },
        fake.server.name,
        {
          store: app.store,
          server: app.server,
          signer: app.tenant.signer(),
          self: app.tenant.serverName,
          keys,
          wake: () => {},
        },
      );
      const first = (await get('notifications')).notifications.find((
        n: { room_id: string },
      ) => n.room_id === fake.roomId);
      assertEquals(
        first.event.unsigned.invite_room_state.find((e: { type: string }) =>
          e.type === 'm.room.name'
        ).content.name,
        'private name',
      );
      const room = await openRoom(app.store, fake.roomId, { create: true });
      const create = await verify(beforeInvite[0], fake.version, keys, {
        roomId: fake.roomId,
      });
      await room.tx(async (tx) => {
        const group = await tx.materialize.newGroup(null, []);
        await tx.segments.create({ kind: 'stay', opening_group: group });
        await ingestInTx(tx, fake.roomId, create.pdu, {
          remote: {
            origin: fake.server.name,
            self: app.tenant.serverName,
            oversized: create.oversized,
            ungroundedMs: 3_600_000,
          },
        });
      });
      const redaction = await fake.addEvent({
        type: 'm.room.redaction',
        prev_events: [topic.event_id!],
        content: { redacts: name.event_id },
      });
      const result = await ingestRemote(
        room,
        [...beforeInvite.slice(1), redaction],
        fake.server.name,
        {
          keys,
          self: app.tenant.serverName,
          fetcher: fakeFetcher({}).fetcher,
          limits: { waitMs: 0, limit: 20, budgetMs: 8000 },
          ungroundedMs: 3_600_000,
        },
      );
      assert(result.every((r) => r.outcome === 'accepted'));
      const notification = (await get('notifications')).notifications.find((
        n: { room_id: string },
      ) => n.room_id === fake.roomId);
      const sync = await get('sync');
      for (
        const shown of [
          notification.event.unsigned.invite_room_state,
          sync.rooms.invite[fake.roomId].invite_state.events,
        ]
      ) {
        assertEquals(
          shown.find((e: { type: string }) => e.type === 'm.room.name').content,
          {},
        );
        assertEquals(
          shown.find((e: { type: string }) => e.type === 'm.room.topic')
            .content,
          full ? { topic: 'retained topic' } : {},
        );
        assert(
          shown.every((e: Record<string, unknown>) =>
            !('source_event_id' in e) && !('event_id' in e) &&
            !('signatures' in e)
          ),
        );
      }
    }
  } finally {
    await http.close();
  }
});
