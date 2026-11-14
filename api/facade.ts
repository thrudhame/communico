// Local/public adapter composition stays outside engine domain owners.
import { adminSocket } from '#engine/config.ts';
import { openFacadeRuntime } from '#engine/facade/runtime.ts';
import { startLinkTransport } from '#engine/facade/transport.ts';
import { facadeOperations } from './admin/facade.ts';
import { operationHandler } from './admin/handler.ts';
import { startAdminHandler } from './admin/socket.ts';
import type { ServerLifetime } from './server-lifetime.ts';
import { config } from '#engine/config.ts';

export async function startFacade(lifetime: ServerLifetime) {
  const runtime = await openFacadeRuntime();
  let link: Awaited<ReturnType<typeof startLinkTransport>> | undefined;
  try {
    link = await startLinkTransport({
      hostname: '0.0.0.0',
      port: config().facade.linkport,
      tls: runtime.tls,
      authorize: runtime.authorize,
      handle: runtime.handle,
    });
    const admin = await startAdminHandler(
      operationHandler({
        ...facadeOperations({
          role: 'facade',
          pairings: runtime.pairings,
          initialize: runtime.initialize,
          status: runtime.status,
          changed: runtime.changed,
        }),
        '/v1/status': runtime.status,
      }),
      adminSocket(),
      lifetime,
    );
    let closed: Promise<void> | undefined;
    return {
      admin,
      runtime,
      close() {
        return closed ??= (async () => {
          await link!.close();
          await runtime.close();
        })();
      },
    };
  } catch (error) {
    await link?.close();
    await runtime.close();
    throw error;
  }
}
