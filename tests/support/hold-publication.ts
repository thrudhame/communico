import type { Database } from '#engine/store/db.ts';

// Hold a real publication transaction, including its actual shared writer
// ownership, not a replacement projector or a delayed HTTP response.
export function holdPublication(
  app: { server: Database },
  roomId: string,
) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = app.server.tx.bind(app.server);
  let held = false;
  app.server.tx = (fn, options) =>
    original(async (conn) => {
      const execute = conn.execute.bind(conn);
      conn.execute = async (sql, values = []) => {
        if (
          !held && sql.startsWith('INSERT INTO feed(') && values[1] === roomId
        ) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return await execute(sql, values);
      };
      return await fn(conn);
    }, options);
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    restore: () => {
      app.server.tx = original;
    },
  };
}
