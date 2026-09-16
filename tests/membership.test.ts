// tests/membership.test.ts — A1–A3 (plan §3g): membership operations and
// power-level rules through the rulebook, engine-level (the endpoints
// mapping these to HTTP land in the next commit; Complement covers the
// wire there). Live doltgres.
import { assertEquals, assertRejects } from '@std/assert';
import { createRoom } from '#engine/room.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { ban, invite, join, kick, leave } from '#engine/membership.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { resetRoom } from './util.ts';

const ROOM = '!membership:localhost';
const ROOM_B = '!membership-b:localhost';

Deno.test('A1: PL 100 via users may lower users_default 100→40', async () => {
  await resetRoom(ROOM);
  await createRoom(ROOM, '@dev:localhost', { roomVersion: '11' });

  // Mirror TestDemotingUsersViaUsersDefault's override outcome: both dev
  // and bob at 100 via users, users_default 100.
  await ingestEvent(
    ROOM,
    await author(ROOM, {
      type: 'm.room.power_levels',
      state_key: '',
      sender: '@dev:localhost',
      content: {
        users: { '@dev:localhost': 100, '@bob:localhost': 100 },
        users_default: 100,
        events: {},
        notifications: {},
      },
    }),
  );
  await invite(ROOM, '@dev:localhost', '@bob:localhost');
  await join(ROOM, '@bob:localhost');

  // bob (100 via users) lowers users_default 100→40 — allowed (the
  // gomatrixserverlib#306 regression: sender's level == old users_default).
  await ingestEvent(
    ROOM,
    await author(ROOM, {
      type: 'm.room.power_levels',
      state_key: '',
      sender: '@bob:localhost',
      content: {
        users: { '@dev:localhost': 100, '@bob:localhost': 100 },
        users_default: 40,
        events: {},
        notifications: {},
      },
    }),
  );
});

Deno.test('A1b: PL {} self-demotion allowed; PL {users:{}} then rejected (rule 9.x)', async () => {
  await resetRoom(ROOM_B);
  await createRoom(ROOM_B, '@dev:localhost', { roomVersion: '11' });

  // Mirror TestPowerLevels' empty-PL sequence: {users:{dev:100}} -> {} ->
  // {users:{}}. The {} send is a self-demotion and must pass; after it
  // dev holds 0, so the next state event is a state-reject (rule 9.x).
  await ingestEvent(
    ROOM_B,
    await author(ROOM_B, {
      type: 'm.room.power_levels',
      state_key: '',
      sender: '@dev:localhost',
      content: { users: { '@dev:localhost': 100 } },
    }),
  );
  await ingestEvent(
    ROOM_B,
    await author(ROOM_B, {
      type: 'm.room.power_levels',
      state_key: '',
      sender: '@dev:localhost',
      content: {},
    }),
  );
  const err = await assertRejects(
    async () =>
      await ingestEvent(
        ROOM_B,
        await author(ROOM_B, {
          type: 'm.room.power_levels',
          state_key: '',
          sender: '@dev:localhost',
          content: { users: {} },
        }),
      ),
    Error,
  );
  assertEquals(err.message.startsWith('M_STATE_REJECT'), true);
});

Deno.test('A2: a never-joined user with PL 100 cannot ban (rule 5)', async () => {
  await resetRoom(ROOM);
  await createRoom(ROOM, '@dev:localhost', { roomVersion: '11' });
  await invite(ROOM, '@dev:localhost', '@bob:localhost');
  await join(ROOM, '@bob:localhost');

  // charlie gets 100 via users but never joins the room
  await ingestEvent(
    ROOM,
    await author(ROOM, {
      type: 'm.room.power_levels',
      state_key: '',
      sender: '@dev:localhost',
      content: { users: { '@charlie:localhost': 100 } },
    }),
  );

  const err = await assertRejects(
    () => ban(ROOM, '@charlie:localhost', '@bob:localhost', 'testing'),
    MatrixError,
  );
  assertEquals(err.status, 403);
  assertEquals(err.errcode, 'M_FORBIDDEN');
});

Deno.test('A3: kick never-present → 403; kick left → 403 (rule 4.5.5)', async () => {
  await resetRoom(ROOM);
  await createRoom(ROOM, '@dev:localhost', { roomVersion: '11' });

  const never = await assertRejects(
    () => kick(ROOM, '@dev:localhost', '@bob:localhost', 'testing'),
    MatrixError,
  );
  assertEquals(never.status, 403);
  assertEquals(never.errcode, 'M_FORBIDDEN');

  await invite(ROOM, '@dev:localhost', '@bob:localhost');
  await join(ROOM, '@bob:localhost');
  await leave(ROOM, '@bob:localhost');

  const left = await assertRejects(
    () => kick(ROOM, '@dev:localhost', '@bob:localhost', 'testing'),
    MatrixError,
  );
  assertEquals(left.status, 403);
  assertEquals(left.errcode, 'M_FORBIDDEN');
});
