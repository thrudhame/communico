import { assertEquals, assertThrows } from '@std/assert';
import { ConfigError, loadConfig } from '#engine/config.ts';

function load(env: Record<string, string> = {}) {
  return loadConfig({
    defaultsPath: 'defaults/communico.toml',
    configPath: null,
    env,
  }).config;
}

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
});

Deno.test('facade configuration refuses unsupported role, protocol modes and unsafe durations', () => {
  for (
    const [key, value] of [
      ['COMMUNICO_SERVER_ROLE', 'proxy'],
      ['COMMUNICO_FACADE_PHASE', 'f2'],
      ['COMMUNICO_FACADE_NOTIFY', 'rpc'],
      ['COMMUNICO_FACADE_OUTBOUND', 'tunnel'],
      ['COMMUNICO_FACADE_POLLSECONDS', '2147484'],
      ['COMMUNICO_FACADE_MAILBOXMAXBYTES', '-1'],
    ]
  ) {
    assertThrows(() => load({ [key]: value }), ConfigError);
  }
});
