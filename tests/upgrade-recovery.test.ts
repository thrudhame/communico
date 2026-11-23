import { assertEquals, assertRejects } from '@std/assert';
import { closeApp, openApp } from '#engine/app.ts';
import { createRoom, writeStateKey } from '#engine/client/write.ts';
import { upgradeRoom } from '#engine/client/upgrade.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { stateAtSeq } from '#engine/client/room.ts';
import { lookupAlias } from '#engine/server/aliases.ts';
import { join, leave } from '#engine/client/membership.ts';
import { MatrixError } from '#engine/matrix-error.ts';

for (const kind of ['tombstone', 'power'] as const) {
  Deno.test(`upgrade conditional ${kind} write preserves a competing state update`, async () => {
    const dir = await Deno.makeTempDir({ prefix: 'upgrade-conditional-' });
    const app = await openApp({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    });
    try {
      const user = await registerUser(app.tenant, {
        localpart: 'upgrader',
        password: 'pw',
      });
      const moderator = '@moderator:' +
        user.user_id.split(':').slice(1).join(':');
      const old = await createRoom({ creator: user.user_id, version: '11' });
      const other = await createRoom({ creator: user.user_id, version: '11' });
      const original =
        (await stateAtSeq(old.roomId, null, [['m.room.power_levels', '']]))[0]
          .content;
      await writeStateKey(old.roomId, user.user_id, 'm.room.power_levels', '', {
        ...original,
        users: { [user.user_id]: 100, [moderator]: 50 },
      });
      const room = app.store.room.bind(app.store);
      const execute = app.server.execute.bind(app.server);
      let armed = false, opens = 0, injected = false, published = false;
      app.server.execute = async (sql, values) => {
        const result = await execute(sql, values);
        if (
          sql.startsWith('UPDATE room_upgrades SET phase=') &&
          values?.[0] === (kind === 'tombstone' ? 2 : 3)
        ) armed = true;
        return result;
      };
      app.store.room = async (id, options) => {
        // The first open starts the conditional action. Its next room open
        // is either a separate stale-read/write gap, or post-commit repair
        // when the action is atomic. Inject outside either room transaction.
        if (armed && id === old.roomId && ++opens === 2) {
          armed = false;
          injected = true;
          if (kind === 'tombstone') {
            published =
              (await stateAtSeq(old.roomId, null, [['m.room.tombstone', '']]))
                .length > 0;
            await writeStateKey(
              old.roomId,
              user.user_id,
              'm.room.tombstone',
              '',
              {
                body: 'concurrent authorized replacement',
                replacement_room: other.roomId,
              },
            );
          } else {
            const pl = (await stateAtSeq(old.roomId, null, [[
              'm.room.power_levels',
              '',
            ]]))[0].content;
            await writeStateKey(
              old.roomId,
              user.user_id,
              'm.room.power_levels',
              '',
              {
                ...pl,
                users: { [user.user_id]: 100, [moderator]: 0 },
                kick: 65,
              },
            );
          }
        }
        return await room(id, options);
      };
      let failure: unknown;
      try {
        await upgradeRoom(old.roomId, user.user_id, '12');
      } catch (error) {
        failure = error;
      } finally {
        app.store.room = room;
        app.server.execute = execute;
      }
      assertEquals(injected, true, 'fixture missed the read/write gap');
      const state = await stateAtSeq(old.roomId, null);
      if (kind === 'tombstone') {
        assertEquals(
          state.find((r) => r.type === 'm.room.tombstone')?.content,
          {
            body: 'concurrent authorized replacement',
            replacement_room: other.roomId,
          },
        );
        const [retained] = await app.server.query(
          'SELECT phase FROM room_upgrades WHERE old_room_id=?',
          [old.roomId],
        );
        if (!published) {
          assertEquals(failure instanceof MatrixError && failure.status, 503);
          assertEquals(retained.phase, 2);
        } else {
          assertEquals(failure, undefined);
        }
      } else {
        assertEquals(failure, undefined);
        const locked = state.find((r) =>
          r.type === 'm.room.power_levels'
        )!.content;
        assertEquals((locked.users as Record<string, number>)[moderator], 0);
        assertEquals(locked.kick, 65);
        assertEquals(locked.invite, 50);
        assertEquals(locked.events_default, 50);
      }
    } finally {
      await closeApp();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

for (const version of ['11', '12']) {
  for (const cut of ['before-publication', 'after-publication', 'push-rules']) {
    Deno.test(`upgrade v${version} cold retry after ${cut} retains its room identity`, async () => {
      const dir = await Deno.makeTempDir({ prefix: 'upgrade-recovery-' });
      const options = {
        dir,
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
        maxopenfiles: 8,
        idleseconds: 300,
      };
      let app = await openApp(options);
      try {
        const user = await registerUser(app.tenant, {
          localpart: 'upgrader',
          password: 'pw',
        });
        const old = await createRoom({ creator: user.user_id, version: '11' });
        const initialize = app.store.initializeRoom.bind(app.store);
        const transaction = app.tenant.tx.bind(app.tenant);
        let expected: string | undefined;
        let injected = false;
        if (cut === 'push-rules') {
          app.tenant.tx = (action) =>
            transaction((tx) => {
              tx.pushRules.roomRulesOf = () => {
                injected = true;
                return Promise.reject(new Error('upgrade-cold-cut'));
              };
              return action(tx);
            });
        } else {
          app.store.initializeRoom = async (roomId, fn) => {
            injected = true;
            expected = roomId;
            if (cut === 'after-publication') await initialize(roomId, fn);
            throw new Error('upgrade-cold-cut');
          };
        }
        try {
          await assertRejects(() =>
            upgradeRoom(old.roomId, user.user_id, version)
          );
        } finally {
          app.store.initializeRoom = initialize;
          app.tenant.tx = transaction;
        }
        assertEquals(injected, true);
        if (cut === 'push-rules') {
          const replacements = (await app.store.rooms()).filter((room) =>
            room !== old.roomId
          );
          assertEquals(replacements.length, 1);
          expected = replacements[0];
        }
        assertEquals(typeof expected, 'string');
        await closeApp();
        app = await openApp(options);
        const result = await upgradeRoom(old.roomId, user.user_id, version);
        assertEquals(result.replacement_room, expected);
        const rooms = await app.store.rooms();
        assertEquals(rooms.length, 2);
        await closeApp();
        app = await openApp(options);
        assertEquals(
          await upgradeRoom(old.roomId, user.user_id, version),
          result,
        );
        assertEquals(await app.store.rooms(), rooms);
      } finally {
        await closeApp();
        await Deno.remove(dir, { recursive: true });
      }
    });
  }
}

Deno.test('upgrade completed result remains stable after later power changes', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'upgrade-recovery-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const app = await openApp(options);
  try {
    const user = await registerUser(app.tenant, {
      localpart: 'upgrader',
      password: 'pw',
    });
    const old = await createRoom({ creator: user.user_id, version: '11' });
    const result = await upgradeRoom(old.roomId, user.user_id, '12');
    await writeStateKey(old.roomId, user.user_id, 'm.room.power_levels', '', {
      users: { [user.user_id]: 0 },
    });
    assertEquals(await upgradeRoom(old.roomId, user.user_id, '12'), result);
  } finally {
    await closeApp();
    await Deno.remove(dir, { recursive: true });
  }
});

for (const phase of [1, 2, 3, 4]) {
  Deno.test(`upgrade cold phase ${phase} replay retains room, alias and state identities`, async () => {
    const dir = await Deno.makeTempDir({ prefix: 'upgrade-recovery-' });
    const options = {
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    };
    let app = await openApp(options);
    try {
      const user = await registerUser(app.tenant, {
        localpart: 'upgrader',
        password: 'pw',
      });
      const old = await createRoom({
        creator: user.user_id,
        alias: 'upgrade-phase-' + phase,
      });
      const execute = app.server.execute.bind(app.server);
      let injected = false;
      app.server.execute = (sql, values) => {
        if (
          sql.startsWith('UPDATE room_upgrades SET phase=') &&
          values?.[0] === phase
        ) {
          injected = true;
          return Promise.reject(new Error('upgrade-phase-cut'));
        }
        return execute(sql, values);
      };
      try {
        await assertRejects(
          () => upgradeRoom(old.roomId, user.user_id, '12'),
          Error,
          'upgrade-phase-cut',
        );
      } finally {
        app.server.execute = execute;
      }
      assertEquals(injected, true);
      const [intent] = await app.server.query(
        'SELECT replacement_room FROM room_upgrades WHERE old_room_id=?',
        [old.roomId],
      );
      const replacement = String(intent.replacement_room);
      const beforeOld = (await stateAtSeq(old.roomId, null)).find((row) =>
        row.type === 'm.room.tombstone'
      );
      const beforeNew = (await stateAtSeq(replacement, null)).find((row) =>
        row.type === 'm.room.canonical_alias'
      );
      await closeApp();
      app = await openApp(options);
      assertEquals(await upgradeRoom(old.roomId, user.user_id, '12'), {
        replacement_room: replacement,
      });
      assertEquals((await app.store.rooms()).length, 2);
      assertEquals(
        await lookupAlias(
          app.server,
          '#upgrade-phase-' + phase + ':' + app.tenant.serverName,
        ),
        replacement,
      );
      const oldState = await stateAtSeq(old.roomId, null);
      const newState = await stateAtSeq(replacement, null);
      if (beforeOld) {
        assertEquals(
          oldState.find((row) => row.type === 'm.room.tombstone'),
          beforeOld,
        );
      }
      if (beforeNew) {
        assertEquals(
          newState.find((row) => row.type === 'm.room.canonical_alias'),
          beforeNew,
        );
      }
    } finally {
      await closeApp();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test('upgrade lockdown storage failure remains pending instead of false completion', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'upgrade-recovery-' });
  const app = await openApp({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  try {
    const user = await registerUser(app.tenant, {
      localpart: 'upgrader',
      password: 'pw',
    });
    const old = await createRoom({ creator: user.user_id });
    const room = app.store.room.bind(app.store);
    const execute = app.server.execute.bind(app.server);
    let cut = false;
    let injected = false;
    app.server.execute = async (sql, values) => {
      const result = await execute(sql, values);
      if (
        sql.startsWith('UPDATE room_upgrades SET phase=') && values?.[0] === 3
      ) cut = true;
      return result;
    };
    // room() returns fresh operation capabilities, not a stable DB object.
    // Intercept the owning lookup after the committed tombstone phase only.
    app.store.room = async (id, options) => {
      const database = await room(id, options);
      if (cut && id === old.roomId) {
        database.tx = () => {
          injected = true;
          return Promise.reject(new Error('upgrade-lockdown-cut'));
        };
      }
      return database;
    };
    try {
      await assertRejects(
        () => upgradeRoom(old.roomId, user.user_id, '12'),
        Error,
        'upgrade-lockdown-cut',
      );
    } finally {
      app.server.execute = execute;
      app.store.room = room;
      assertEquals(injected, true, 'the lockdown fault must actually occur');
    }
    const [row] = await app.server.query(
      'SELECT phase,replacement_room FROM room_upgrades WHERE old_room_id=?',
      [old.roomId],
    );
    assertEquals(row.phase, 3);
    assertEquals(await upgradeRoom(old.roomId, user.user_id, '12'), {
      replacement_room: row.replacement_room,
    });
    assertEquals((await app.store.rooms()).length, 2);
  } finally {
    await closeApp();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('upgrade reuses an existing tombstone and replacement without rewriting either', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'upgrade-recovery-' });
  const app = await openApp({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  try {
    const user = await registerUser(app.tenant, {
      localpart: 'upgrader',
      password: 'pw',
    });
    const old = await createRoom({ creator: user.user_id });
    const replacement = await createRoom({
      creator: user.user_id,
      version: '12',
      creation_content: { predecessor: { room_id: old.roomId } },
    });
    await writeStateKey(old.roomId, user.user_id, 'm.room.tombstone', '', {
      body: 'Previously upgraded',
      replacement_room: replacement.roomId,
    });
    const before = (await stateAtSeq(old.roomId, null)).find((row) =>
      row.type === 'm.room.tombstone'
    );
    const rooms = await app.store.rooms();
    assertEquals(await upgradeRoom(old.roomId, user.user_id, '12'), {
      replacement_room: replacement.roomId,
    });
    assertEquals(await app.store.rooms(), rooms);
    assertEquals(
      (await stateAtSeq(old.roomId, null)).find((row) =>
        row.type === 'm.room.tombstone'
      ),
      before,
    );
  } finally {
    await closeApp();
    await Deno.remove(dir, { recursive: true });
  }
});

async function withUpgradeApp(
  run: (app: Awaited<ReturnType<typeof openApp>>) => Promise<void>,
) {
  const dir = await Deno.makeTempDir({ prefix: 'upgrade-recovery-' });
  const app = await openApp({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  try {
    await run(app);
  } finally {
    await closeApp();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('upgrade lockdown retry derives from current power, never a stale plan', () =>
  withUpgradeApp(async (app) => {
    const user = await registerUser(app.tenant, {
      localpart: 'upgrader',
      password: 'pw',
    });
    const moderator = '@moderator:' + user.user_id.split(':')[1];
    const old = await createRoom({ creator: user.user_id, version: '11' });
    const power = (await stateAtSeq(old.roomId, null, [[
      'm.room.power_levels',
      '',
    ]]))[0].content as Record<string, unknown>;
    await writeStateKey(old.roomId, user.user_id, 'm.room.power_levels', '', {
      ...power,
      users: { [user.user_id]: 100, [moderator]: 50 },
    });
    const room = app.store.room.bind(app.store);
    const execute = app.server.execute.bind(app.server);
    let cut = false;
    app.server.execute = async (sql, values) => {
      const result = await execute(sql, values);
      if (
        sql.startsWith('UPDATE room_upgrades SET phase=') && values?.[0] === 3
      ) cut = true;
      return result;
    };
    app.store.room = async (id, options) => {
      const database = await room(id, options);
      if (cut && id === old.roomId) {
        database.tx = () => Promise.reject(new Error('upgrade-lockdown-cut'));
      }
      return database;
    };
    try {
      await assertRejects(
        () => upgradeRoom(old.roomId, user.user_id, '12'),
        Error,
        'upgrade-lockdown-cut',
      );
    } finally {
      app.server.execute = execute;
      app.store.room = room;
    }
    // The owner removes the moderator while lockdown is pending.
    await writeStateKey(old.roomId, user.user_id, 'm.room.power_levels', '', {
      ...power,
      users: { [user.user_id]: 100 },
      events_default: 0,
      invite: 75,
    });
    await upgradeRoom(old.roomId, user.user_id, '12');
    const locked = (await stateAtSeq(old.roomId, null, [[
      'm.room.power_levels',
      '',
    ]]))[0].content as Record<string, unknown>;
    assertEquals(locked.users, { [user.user_id]: 100 });
    // Synapse raises only levels below max(users_default + 1, 50).
    assertEquals([locked.events_default, locked.invite], [50, 75]);
  }));

Deno.test('upgrade requests with different parameters never share a retained result', () =>
  withUpgradeApp(async (app) => {
    const user = await registerUser(app.tenant, {
      localpart: 'upgrader',
      password: 'pw',
    });
    const old = await createRoom({ creator: user.user_id, version: '11' });
    const raced = await Promise.allSettled([
      upgradeRoom(old.roomId, user.user_id, '12'),
      upgradeRoom(old.roomId, user.user_id, '11'),
    ]);
    const done = raced.flatMap((r) =>
      r.status === 'fulfilled' ? [r.value] : []
    );
    const refused = raced.flatMap((r) =>
      r.status === 'rejected' ? [r.reason] : []
    );
    assertEquals(done.length, 1);
    assertEquals(refused.length, 1);
    assertEquals(refused[0] instanceof MatrixError, true);
    assertEquals([refused[0].status, refused[0].errcode], [400, 'M_BAD_STATE']);
    const version = raced[0].status === 'fulfilled' ? '12' : '11';
    const other = version === '12' ? '11' : '12';
    const error = await assertRejects(
      () => upgradeRoom(old.roomId, user.user_id, other),
      MatrixError,
    );
    assertEquals([error.status, error.errcode], [400, 'M_BAD_STATE']);
    assertEquals(await upgradeRoom(old.roomId, user.user_id, version), done[0]);
    assertEquals((await app.store.rooms()).length, 2);
  }));

Deno.test('upgrade by a powered user who left starts no upgrade effects', () =>
  withUpgradeApp(async (app) => {
    const user = await registerUser(app.tenant, {
      localpart: 'upgrader',
      password: 'pw',
    });
    const former = await registerUser(app.tenant, {
      localpart: 'former',
      password: 'pw',
    });
    const old = await createRoom({
      creator: user.user_id,
      version: '11',
      preset: 'public_chat',
    });
    const power = (await stateAtSeq(old.roomId, null, [[
      'm.room.power_levels',
      '',
    ]]))[0].content as Record<string, unknown>;
    await writeStateKey(old.roomId, user.user_id, 'm.room.power_levels', '', {
      ...power,
      users: { [user.user_id]: 100, [former.user_id]: 100 },
    });
    await join(old.roomId, former.user_id);
    await leave(old.roomId, former.user_id);
    const rooms = await app.store.rooms();
    const error = await assertRejects(
      () => upgradeRoom(old.roomId, former.user_id, '12'),
      MatrixError,
    );
    assertEquals([error.status, error.errcode], [403, 'M_FORBIDDEN']);
    assertEquals(
      await app.server.query('SELECT * FROM room_upgrades'),
      [],
    );
    assertEquals(await app.store.rooms(), rooms);
    // The joined owner can still upgrade: nothing was retained for the leaver.
    assertEquals(
      typeof (await upgradeRoom(old.roomId, user.user_id, '12'))
        .replacement_room,
      'string',
    );
  }));
