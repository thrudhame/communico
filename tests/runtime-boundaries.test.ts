import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  formatShellExports,
  loadConfig,
  setConfigForTests,
} from '#engine/config.ts';
import { envNameOf, leaves, SCHEMA } from '#engine/config-schema.ts';
import { closeApp, openApp } from '#engine/app.ts';
import { Turso } from '#engine/store/ffi.ts';

const defaultsPath = 'defaults/communico.toml';

Deno.test('runtime boundaries: defaults are mandatory even with every environment leaf', () => {
  const { config } = loadConfig({ defaultsPath, configPath: null, env: {} });
  const exports = formatShellExports(config);
  const env = Object.fromEntries(
    exports.trim().split('\n').map((line) => {
      const [, key, value] = /^export ([A-Z0-9_]+)='(.*)'$/.exec(line)!;
      return [key, value];
    }),
  );
  const error = assertThrows(() =>
    loadConfig({
      defaultsPath: defaultsPath + '.missing',
      configPath: null,
      env,
    }), Error);
  assert(error.message.includes('missing defaults file'));
});

Deno.test('runtime boundaries: every numeric leaf rejects negative and unsafe values', () => {
  for (const [path, type] of leaves(SCHEMA)) {
    if (type !== 'int') continue;
    for (const value of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      const error = assertThrows(
        () =>
          loadConfig({
            defaultsPath,
            configPath: null,
            env: { [envNameOf(path)]: String(value) },
          }),
        Error,
        undefined,
        path.join('.'),
      );
      assert(error.message.includes(path.join('.')), path.join('.'));
    }
  }
  for (
    const [key, value] of [
      ['MEDIA_CLEANUPSECONDS', 2147484],
      ['MEDIA_THUMBNAILMS', 2147483648],
      ['FEDERATION_TIMEOUTMS', 2147483648],
      ['SERVER_PORT', 65536],
      ['PREVIEW_MAXBYTES', 0],
      ['STORE_MAXOPENFILES', 0],
    ] as const
  ) {
    assertThrows(() =>
      loadConfig({
        defaultsPath,
        configPath: null,
        env: { ['COMMUNICO_' + key]: String(value) },
      })
    );
  }
  loadConfig({
    defaultsPath,
    configPath: null,
    env: {
      COMMUNICO_MEDIA_CLEANUPSECONDS: '2147483',
      COMMUNICO_MEDIA_THUMBNAILMS: '2147483647',
      COMMUNICO_TURN_TTL: '0',
      COMMUNICO_E2EE_MAXKEYS: '0',
      COMMUNICO_PUSH_READRETENTIONDAYS: '0',
      COMMUNICO_PEEKING_MAXTIMEOUTMS: '0',
    },
  });
});

Deno.test('runtime boundaries: native results never silently round integers', async () => {
  const native = new Turso('./.native/libturso_ffi.so');
  const file = await native.open(':memory:');
  const connection = await native.connect(file);
  try {
    for (
      const sql of [
        'SELECT 9007199254740992 AS n',
        'SELECT -9007199254740992 AS n',
        'SELECT sum(n) AS n FROM (SELECT 9007199254740991 AS n UNION ALL SELECT 1)',
      ]
    ) {
      await assertRejects(
        () => native.query(connection, sql),
        TypeError,
        'safe',
      );
    }
    assertEquals(
      await native.query(
        connection,
        'SELECT 9007199254740991 AS hi, -9007199254740991 AS lo, 1.25 AS real',
      ),
      [{
        hi: Number.MAX_SAFE_INTEGER,
        lo: -Number.MAX_SAFE_INTEGER,
        real: 1.25,
      }],
    );
  } finally {
    await native.closeConnection(connection);
    await native.closeFile(file);
    native.close();
  }
});

Deno.test('runtime boundaries: app teardown drains resources and retains simultaneous failures', async () => {
  const dir = await Deno.makeTempDir();
  setConfigForTests({ federation: { enabled: false } });
  const app = await openApp({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  const failures = [
    new Error('sender failed'),
    new Error('push failed'),
    new Error('store failed'),
  ];
  const stopped: string[] = [];
  const stopPush = app.pushSender.stop.bind(app.pushSender);
  const closeStore = app.store.close.bind(app.store);
  app.sender = {
    stop: () => {
      stopped.push('sender');
      throw failures[0];
    },
  } as unknown as NonNullable<typeof app.sender>;
  app.pushSender.stop = async () => {
    stopped.push('push');
    await stopPush();
    throw failures[1];
  };
  app.store.close = async () => {
    stopped.push('store');
    await closeStore();
    throw failures[2];
  };
  try {
    const error = await assertRejects(() => closeApp(), AggregateError);
    const flatten = (e: unknown): unknown[] =>
      e instanceof AggregateError ? e.errors.flatMap(flatten) : [e];
    assertEquals(flatten(error), failures);
    assertEquals(stopped, ['sender', 'push', 'store']);
  } finally {
    setConfigForTests({});
    await Deno.remove(dir, { recursive: true });
  }
});
