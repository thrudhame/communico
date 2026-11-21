import { assertEquals, assertRejects } from '@std/assert';
import { closeApp, openApp } from '#engine/app.ts';
import { createRoom, writeStateKey } from '#engine/client/write.ts';
import { upgradeRoom } from '#engine/client/upgrade.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { stateAtSeq } from '#engine/client/room.ts';
import { lookupAlias } from '#engine/server/aliases.ts';

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
