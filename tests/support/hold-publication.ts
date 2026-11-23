import type { Conn, Database } from '#engine/store/db.ts';

// Test effects follow the room's actual native feed advancement, never a
// scalar/JSON parameter layout. The callback still owns the uncommitted turn.
export function observePublication(
  app: { server: Database },
  roomId: string,
  effect: (conn: Conn) => Promise<void>,
) {
  const original = app.server.tx.bind(app.server);
  app.server.tx = (fn, options) =>
    original(async (conn) => {
      const head = async () =>
        Number(
          (await conn.query(
            'SELECT COALESCE(MAX(seq),0) AS seq FROM feed WHERE room=?',
            [roomId],
          ))[0].seq,
        );
      let observed = await head();
      const execute = conn.execute.bind(conn);
      conn.execute = async (sql, values) => {
        const result = await execute(sql, values);
        const current = await head();
        if (current > observed) {
          observed = current;
          await effect(conn);
        }
        return result;
      };
      return await fn(conn);
    }, options);
  return () => {
    app.server.tx = original;
  };
}

// Hold a real publication transaction, including its actual shared writer
// ownership, not a replacement projector or a delayed HTTP response.
export function holdPublication(
  app: { server: Database },
  roomId: string,
) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held = false;
  const restore = observePublication(app, roomId, async () => {
    if (held) return;
    held = true;
    entered.resolve();
    await release.promise;
  });
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    restore,
  };
}
