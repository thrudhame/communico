import { assert, assertEquals } from '@std/assert';
import { startHttp } from '#tests/http-app.ts';
import { receiveInvite } from '#engine/federation/invites.ts';
import { openRoom } from '#engine/room/index.ts';
import { ingestInTx } from '#engine/room/ingest.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { backfill } from '#engine/room/history.ts';
import { verify } from '#engine/room/verify.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  wireOf,
} from '#tests/fixtures/remote.ts';
import { makeFakeRoom } from '#tests/fixtures/remote-room.ts';
import { savedContentView } from '#engine/federation/prejoin.ts';

Deno.test('saved display shape is recursively subtractive and incompatible arrays fail closed', () => {
  assertEquals(
    savedContentView({
      nested: { shown: 'saved', private: 'remove' },
      absent: 'remove',
      wrong: { secret: true },
    }, {
      nested: { shown: 'source', omitted: 'never restore' },
      wrong: 'source scalar',
    }),
    { nested: { shown: 'saved' } },
  );
  assertEquals(
    savedContentView([{ shown: 'saved', private: 1 }], [{
      shown: 'source',
    }]),
    [{ shown: 'saved' }],
  );
  for (
    const [saved, allowed] of [
      [[1], [{}]],
      [[1, 2], [1]],
      [{}, []],
      [null, {}],
      ['saved', {}],
    ]
  ) assertEquals(savedContentView(saved, allowed), undefined);
  assertEquals(savedContentView({}, { missing: 'never restore' }), {});
  assertEquals(savedContentView(null, null), null);
});

Deno.test('saved membership hints obey nested redaction in real invite notifications without restoring partial content', async () => {
  const http = await startHttp();
  try {
    const { app } = http;
    const user = await http.registerTestUser('nested-hint-reader', 'pw');
    for (const partial of [false, true]) {
      const fake = await makeFakeRoom({
        roomId: '!nested-hint-' + partial + ':remote.test',
      });
      const genesis = [...fake.events.values()];
      const signed = { token: 'retained-token', mxid: user.user_id };
      // An authorized historical ban has no effect on the current published
      // membership. Its opaque extra content is still subject to redaction.
      const historical = await fake.addEvent({
        type: 'm.room.member',
        state_key: user.user_id,
        content: {
          membership: 'ban',
          third_party_invite: { signed, display_name: 'private nested name' },
        },
      });
      const redaction = await fake.addEvent({
        type: 'm.room.redaction',
        prev_events: [genesis.at(-1)!.event_id!],
        content: { redacts: historical.event_id },
      });
      const keys = fakeKeyResolver(fake.server);
      const room = await openRoom(app.store, fake.roomId, { create: true });
      const create = await verify(genesis[0], fake.version, keys, {
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
      const deps = {
        keys,
        self: app.tenant.serverName,
        fetcher: fakeFetcher({}).fetcher,
        limits: { waitMs: 0, limit: 20, budgetMs: 8000 },
        ungroundedMs: 3_600_000,
      };
      const initial = await ingestRemote(
        room,
        genesis.slice(1),
        fake.server.name,
        deps,
      );
      assert(initial.every((r) => r.outcome === 'accepted'));
      const imported = await backfill(room, {
        from: [historical.event_id!],
        limit: 1,
        via: fake.server.name,
        anchor: historical,
      }, deps);
      assert(imported.positioned.includes(historical.event_id!));
      const applied = await ingestRemote(
        room,
        [redaction],
        fake.server.name,
        deps,
      );
      assertEquals(applied[0].outcome, 'accepted');
      await room.tx(async (tx) => {
        const stay = await tx.segments.openStay();
        assert(stay !== null);
        await tx.segments.close(stay.id);
      });

      const invite = await fake.addEvent({
        type: 'm.room.member',
        state_key: user.user_id,
        content: { membership: 'invite' },
      });
      const hint = wireOf(historical);
      if (partial) {
        hint.content = { membership: 'ban', third_party_invite: { signed } };
      }
      await receiveInvite(
        fake.roomId,
        invite.event_id!,
        {
          room_version: fake.version,
          event: wireOf(invite),
          invite_room_state: [wireOf(genesis[0]), hint],
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
      const response = await http.matrix(
        new Request('http://x/_matrix/client/v3/notifications', {
          headers: { Authorization: 'Bearer ' + user.access_token },
        }),
      );
      assertEquals(response.status, 200);
      const body = await response.json();
      const notification = body.notifications.find((n: { room_id: string }) =>
        n.room_id === fake.roomId
      );
      assert(
        notification !== undefined,
        'the authoritative pending invite is visible',
      );
      const shown = notification.event.unsigned.invite_room_state.find((e: {
        type: string;
      }) => e.type === 'm.room.member');
      assertEquals(shown.content, {
        membership: 'ban',
        third_party_invite: { signed },
      });
    }
  } finally {
    await http.close();
  }
});
