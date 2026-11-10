import { assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { SERVER_V13 } from '#tests/fixtures/server-v13.ts';

Deno.test('prejoin v20 upgrade preserves v19 invite events, sequences and unbounded rejection work', async () => {
  const dir = await Deno.makeTempDir();
  const config = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  try {
    const legacy = await openStore(config, {
      schemas: { server: { version: 13, apply: (db) => db.exec(SERVER_V13) } },
    });
    const old = await legacy.server();
    for (
      const [user, status, seq] of [['@a:test', 'pending', 41], [
        '@b:test',
        'rejecting',
        42,
      ], ['@c:test', 'joined', 43]] as const
    ) {
      await old.execute(
        "INSERT INTO federation_invites VALUES('!room:test',?,'$event','11','{\"content\":{\"membership\":\"invite\"}}','[]','remote.test',100,?,?)",
        [user, status, seq],
      );
    }
    await old.execute("INSERT INTO counters VALUES('events',43)");
    await legacy.close();
    const v19 = await openStore(config, {
      schemas: { server: { ...serverSchema, version: 19 } },
    });
    await v19.close();
    const v22 = await openStore(config, {
      schemas: { server: { ...serverSchema, version: 22 } },
    });
    await v22.close();
    const current = await openStore(config, {
      schemas: { server: serverSchema },
    });
    const db = await current.server();
    assertEquals(
      await db.query(
        'SELECT local_leave_json FROM prejoin_memberships ORDER BY seq',
      ),
      [{ local_leave_json: null }, { local_leave_json: null }, {
        local_leave_json: null,
      }],
    );
    assertEquals(
      await db.query(
        'SELECT user_id,status,seq,kind,revision,expires_ms,leave_json FROM prejoin_memberships ORDER BY seq',
      ),
      [
        {
          user_id: '@a:test',
          status: 'pending',
          seq: 41,
          kind: 'invite',
          revision: 1,
          expires_ms: null,
          leave_json: null,
        },
        {
          user_id: '@b:test',
          status: 'rejecting',
          seq: 42,
          kind: 'invite',
          revision: 1,
          expires_ms: null,
          leave_json: null,
        },
        {
          user_id: '@c:test',
          status: 'joined',
          seq: 43,
          kind: 'invite',
          revision: 1,
          expires_ms: null,
          leave_json: null,
        },
      ],
    );
    assertEquals(
      await db.query("SELECT value FROM counters WHERE name='events'"),
      [{ value: 43 }],
    );
    assertEquals(
      await db.query(
        "SELECT name FROM sqlite_master WHERE name='federation_invites'",
      ),
      [],
    );
    await current.close();
    const reopened = await openStore(config, {
      schemas: { server: serverSchema },
    });
    assertEquals(
      (await (await reopened.server()).query(
        'SELECT * FROM prejoin_memberships',
      )).length,
      3,
    );
    await reopened.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
