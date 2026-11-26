import { assertEquals, assertThrows } from '@std/assert';
import { ConfigError, loadConfig } from '#engine/config.ts';

function load(env: Record<string, string> = {}) {
  return loadConfig({
    defaultsPath: 'defaults/communico.toml',
    configPath: null,
    env,
  }).config;
}

Deno.test('facade storage budget accepts default, uncapped and aggregate bytes', () => {
  assertEquals(load().facade.storagebudgetbytes, -1);
  const withBudget = (bytes: string) =>
    load({ COMMUNICO_FACADE_STORAGEBUDGETBYTES: bytes }).facade
      .storagebudgetbytes;
  assertEquals(withBudget('0'), 0);
  assertEquals(withBudget('16777216'), 16 * 1024 * 1024);
  assertThrows(() => withBudget('-2'), ConfigError, 'storagebudgetbytes');
});

Deno.test('facade configuration preserves standalone home and exposes typed layered settings', () => {
  assertEquals(load().server.role, 'home');
  assertEquals(load().facade.nodes, []);
  const cfg = load({
    COMMUNICO_SERVER_ROLE: 'facade',
    COMMUNICO_FACADE_NODEID: 'edge_a',
    COMMUNICO_FACADE_NOTIFY: 'sse',
  });
  assertEquals(cfg.server.role, 'facade');
  assertEquals(cfg.facade.nodeid, 'edge_a');
  assertEquals(cfg.facade.notify, 'sse');
  assertEquals(cfg.facade.maxofflinedays, 0);
  assertEquals(cfg.facade.replicatecredentials, true);
  assertEquals(cfg.facade.allowstaleauth, true);
  assertEquals(cfg.facade.authmaxstalehours, 0);
  const strict = load({
    COMMUNICO_FACADE_PHASE: 'f2',
    COMMUNICO_FACADE_REPLICATECREDENTIALS: 'false',
    COMMUNICO_FACADE_ALLOWSTALEAUTH: 'false',
    COMMUNICO_FACADE_AUTHMAXSTALEHOURS: '2',
  });
  assertEquals(strict.facade.phase, 'f2');
  assertEquals(strict.facade.replicatecredentials, false);
  assertEquals(strict.facade.allowstaleauth, false);
  assertEquals(strict.facade.authmaxstalehours, 2);
});

Deno.test('facade configuration refuses unsupported role, protocol modes and unsafe durations', () => {
  for (
    const [key, value] of [
      ['COMMUNICO_SERVER_ROLE', 'proxy'],
      ['COMMUNICO_FACADE_PHASE', 'f3'],
      ['COMMUNICO_FACADE_NOTIFY', 'rpc'],
      ['COMMUNICO_FACADE_OUTBOUND', 'tunnel'],
      ['COMMUNICO_FACADE_POLLSECONDS', '2147484'],
      ['COMMUNICO_FACADE_MAILBOXMAXBYTES', '-1'],
      ['COMMUNICO_FACADE_AUTHMAXSTALEHOURS', '-1'],
      ['COMMUNICO_FACADE_REPLICATECREDENTIALS', '0'],
    ]
  ) {
    assertThrows(() => load({ [key]: value }), ConfigError);
  }
});
