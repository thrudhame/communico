import { assert, assertEquals, assertRejects } from '@std/assert';
import type { InviteDeps } from '#engine/federation/invites.ts';
import { makeJoin, makeKnock } from '#engine/federation/joins.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { roomSchema } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { join, leave, reopen } from '#engine/room/membership.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { type Genesis, genesis } from './fixtures/genesis.ts';

async function withRoom(
  joinRule: string,
  fn: (store: Store, g: Genesis) => Promise<void>,
  version = '11',
) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema, server: serverSchema } });
  try {
    await fn(
      store,
      await genesis(store, { roomId: '!parent-state:test', joinRule, version }),
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function deeperBranches(g: Genesis) {
  for (let branch = 0; branch < 24; branch++) {
    let tip = g.tipId;
    for (let step = 0; step < 2; step++) {
      const result = await sendLocal(g.room, {
        type: 'm.room.message',
        sender: g.creator,
        content: { msgtype: 'm.text', body: `branch ${branch} step ${step}` },
        prev_events: [tip],
        origin_server_ts: 1000 + branch * 2 + step,
      }, g.signer);
      assertEquals(result.standing, 'accepted');
      tip = result.eventId;
    }
  }
}

async function branchRule(g: Genesis, rule: string) {
  const result = await sendLocal(g.room, {
    type: 'm.room.join_rules',
    state_key: '',
    sender: g.creator,
    content: { join_rule: rule },
    prev_events: [g.tipId],
    origin_server_ts: 2000,
  }, g.signer);
  assertEquals(result.standing, 'accepted');
  return result.eventId;
}

async function depsFor(store: Store, g: Genesis) {
  return {
    store,
    server: await store.server(),
    self: g.signer.serverName,
    signer: g.signer,
  } as InviteDeps;
}

for (const version of ['11', '12']) {
  for (const consumer of ['federation template', 'local join']) {
    Deno.test(`parent state: v${version} restricted ${consumer} selects an authorizer in both views`, async () => {
      await withRoom('public', async (store, g) => {
        const allowed = await genesis(store, {
          roomId: '!parent-allowed:test',
          joinRule: 'public',
        });
        const guest = '@guest:test';
        await join(allowed.room, guest, g.signer);
        const rule = await sendLocal(g.room, {
          type: 'm.room.join_rules',
          state_key: '',
          sender: g.creator,
          content: {
            join_rule: 'restricted',
            allow: [{ type: 'm.room_membership', room_id: allowed.roomId }],
          },
        }, g.signer);
        assertEquals(rule.standing, 'accepted');
        g.tipId = rule.eventId;
        await deeperBranches(g);
        const omitted = await sendLocal(g.room, {
          type: 'm.room.member',
          state_key: '@aaa:test',
          sender: '@aaa:test',
          content: {
            membership: 'join',
            join_authorised_via_users_server: g.creator,
          },
          prev_events: [g.tipId],
        }, g.signer);
        assertEquals(omitted.standing, 'accepted');
        await g.room.tx(async (tx) => {
          const stay = (await tx.segments.openStay())!;
          assert(
            !(await tx.extremities.parents(stay.id)).includes(omitted.eventId),
          );
          assertEquals(
            await tx.state.groupKey(
              (await tx.state.current(stay.id))!,
              'm.room.member',
              '@aaa:test',
            ),
            omitted.eventId,
          );
        });
        if (consumer === 'federation template') {
          const template = await makeJoin(
            g.roomId,
            guest,
            'test',
            [version],
            await depsFor(store, g),
          );
          assertEquals(
            template.event.content.join_authorised_via_users_server,
            g.creator,
          );
          assert(!template.event.auth_events.includes(omitted.eventId));
        } else {
          const result = await join(g.room, guest, g.signer);
          const pdu = await g.room.tx(async (tx) =>
            JSON.parse((await tx.events.get(result.eventId))!.pdu)
          );
          assertEquals(pdu.content.join_authorised_via_users_server, g.creator);
          assertEquals(pdu.content.membership, 'join');
        }
      }, version);
    });
  }
}

Deno.test('parent state: federation template auth cites selected-parent state, not omitted current state', async () => {
  await withRoom('public', async (store, g) => {
    const originalRule = await g.room.tx(async (tx) => {
      const after = (await tx.state.eventStateAfter(g.tipId))!;
      return await tx.state.groupKey(after.group, 'm.room.join_rules', '');
    });
    await deeperBranches(g);
    const omittedRule = await branchRule(g, 'public');
    const template = await makeJoin(
      g.roomId,
      '@new:remote.test',
      'remote.test',
      ['11'],
      await depsFor(store, g),
    );
    assert(!template.event.prev_events.includes(omittedRule));
    assert(template.event.auth_events.includes(originalRule!));
    assert(!template.event.auth_events.includes(omittedRule));
  });
});

for (const rule of ['public', 'knock']) {
  Deno.test(`parent state: ${rule} outside selected parents cannot authorize an unusable template`, async () => {
    await withRoom('invite', async (store, g) => {
      await deeperBranches(g);
      const omittedRule = await branchRule(g, rule);
      await g.room.tx(async (tx) => {
        const stay = (await tx.segments.openStay())!;
        assertEquals(
          await tx.state.groupKey(
            (await tx.state.current(stay.id))!,
            'm.room.join_rules',
            '',
          ),
          omittedRule,
        );
        assert(!(await tx.extremities.parents(stay.id)).includes(omittedRule));
      });
      const deps = await depsFor(store, g);
      await assertRejects(
        () =>
          rule === 'public'
            ? makeJoin(
              g.roomId,
              '@new:remote.test',
              'remote.test',
              ['11'],
              deps,
            )
            : makeKnock(
              g.roomId,
              '@new:remote.test',
              'remote.test',
              ['11'],
              deps,
            ),
        MatrixError,
      );
    });
  });
}

for (const rule of ['public', 'knock']) {
  Deno.test(`parent state: ${rule} parents cannot bypass a newer current invite rule`, async () => {
    await withRoom(rule, async (store, g) => {
      await deeperBranches(g);
      const omittedRule = await branchRule(g, 'invite');
      await g.room.tx(async (tx) => {
        const stay = (await tx.segments.openStay())!;
        assertEquals(
          await tx.state.groupKey(
            (await tx.state.current(stay.id))!,
            'm.room.join_rules',
            '',
          ),
          omittedRule,
        );
        assert(!(await tx.extremities.parents(stay.id)).includes(omittedRule));
      });
      const deps = await depsFor(store, g);
      await assertRejects(
        () =>
          rule === 'public'
            ? makeJoin(
              g.roomId,
              '@new:remote.test',
              'remote.test',
              ['11'],
              deps,
            )
            : makeKnock(
              g.roomId,
              '@new:remote.test',
              'remote.test',
              ['11'],
              deps,
            ),
        MatrixError,
      );
    });
  });
}

Deno.test('parent state: archived reopen retains omitted branch state in the new publication', async () => {
  await withRoom('public', async (_store, g) => {
    await deeperBranches(g);
    const topic = await sendLocal(g.room, {
      type: 'm.room.topic',
      state_key: '',
      sender: g.creator,
      content: { topic: 'retained omitted branch' },
      prev_events: [g.tipId],
      origin_server_ts: 2100,
    }, g.signer);
    assertEquals(topic.standing, 'accepted');
    await leave(g.room, g.creator, g.signer);
    const archived = await g.room.tx(async (tx) => {
      const stay = (await tx.segments.latestStay())!;
      assertEquals(await tx.segments.openStay(), null);
      const heads = await tx.extremities.frontier(stay.id);
      assert(heads.includes(topic.eventId));
      assert(!(await tx.extremities.parents(stay.id)).includes(topic.eventId));
      assertEquals(
        await tx.state.groupKey(
          (await tx.state.current(stay.id))!,
          'm.room.topic',
          '',
        ),
        topic.eventId,
      );
      return { stay: stay.id, heads };
    });
    const joined = await reopen(g.room, g.creator, g.signer, {});
    await g.room.tx(async (tx) => {
      const stay = (await tx.segments.openStay())!;
      const pdu = JSON.parse((await tx.events.get(joined.eventId))!.pdu) as Pdu;
      assertEquals(pdu.prev_events!.length, 10);
      assert(!pdu.prev_events!.includes(topic.eventId));
      assertEquals(
        await tx.state.groupKey(
          (await tx.state.current(stay.id))!,
          'm.room.topic',
          '',
        ),
        topic.eventId,
      );
      const expected = [
        ...archived.heads.filter((id) => !pdu.prev_events!.includes(id)),
        joined.eventId,
      ].sort();
      assertEquals(await tx.extremities.frontier(stay.id), expected);
      assertEquals(
        await tx.extremities.frontier(archived.stay),
        archived.heads,
      );
    });
  });
});
