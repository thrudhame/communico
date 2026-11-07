import { assertEquals } from '@std/assert';
import { type Conn, operations } from '#engine/store/db.ts';
import { startHttp } from '#tests/http-app.ts';

Deno.test('directory: live join-rule discovery reads only its selected state key', async () => {
  const http = await startHttp();
  const app = http.app;
  const original = app.store.room.bind(app.store);
  const types: string[] = [];
  try {
    const searcher = await http.registerTestUser(
      'directory-cost-searcher',
      'pw',
    );
    const owner = await http.registerTestUser('directory-cost-owner', 'pw');
    const created = await http.matrix(
      new Request('http://x/_matrix/client/v3/createRoom', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + owner.access_token },
        body: JSON.stringify({
          preset: 'public_chat',
          initial_state: Array.from(
            { length: 40 },
            (_, i) => ({
              type: 'org.test.unrelated',
              state_key: String(i),
              content: { payload: 'not directory data' },
            }),
          ),
        }),
      }),
    );
    await created.arrayBuffer();
    assertEquals(created.status, 200);
    app.store.room = async (...args) => {
      const db = await original(...args);
      return operations((fn, options) =>
        db.tx((conn) =>
          fn(
            new Proxy(conn, {
              get(target, key) {
                if (key === 'query') {
                  return async (...params: Parameters<Conn['query']>) => {
                    const rows = await target.query(...params);
                    if (params[0].includes('FROM events')) {
                      for (const row of rows) {
                        if (typeof row.type === 'string') types.push(row.type);
                      }
                    }
                    return rows;
                  };
                }
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ), options), db.path);
    };
    const response = await http.matrix(
      new Request('http://x/_matrix/client/v3/user_directory/search', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + searcher.access_token },
        body: JSON.stringify({ search_term: 'directory-cost-owner' }),
      }),
    );
    const found = await response.json();
    assertEquals(response.status, 200);
    assertEquals(found.results.map((r: { user_id: string }) => r.user_id), [
      owner.user_id,
    ]);
    assertEquals(types, ['m.room.join_rules']);
  } finally {
    app.store.room = original;
    await http.close();
  }
});
