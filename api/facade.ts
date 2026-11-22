// Local/public adapter composition stays outside engine domain owners.
import { adminSocket } from '#engine/config.ts';
import { openFacadeRuntime } from '#engine/facade/runtime.ts';
import { startLinkTransport } from '#engine/facade/transport.ts';
import { facadeOperations } from './admin/facade.ts';
import { operationHandler } from './admin/handler.ts';
import { startAdminHandler } from './admin/socket.ts';
import type { ServerLifetime } from './server-lifetime.ts';
import { config } from '#engine/config.ts';
import { appPort } from '#engine/config.ts';
import { closeApp, openReplicaApp, prepareAppRecovery } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { LinkError } from '#engine/facade/protocol.ts';
import { pathfinder } from '@pathfinder/pathfinder';
import type { Scope } from '#engine/facade/capabilities.ts';
import { federationPolicy } from '#engine/federation/policy.ts';
import { requestFailure } from '#engine/request-diagnostics.ts';

export async function startFacade(
  lifetime: ServerLifetime,
  fail: (error: unknown) => void,
) {
  prepareAppRecovery();
  const runtime = await openFacadeRuntime();
  let link: Awaited<ReturnType<typeof startLinkTransport>> | undefined;
  const servers: Deno.HttpServer[] = [];
  let composed = false;
  let appBound = false;
  let composing: Promise<void> | undefined;
  let compositionFailed = false;
  const status = async () => {
    const state = await runtime.status();
    return { ...state, matrix: composed && state.enrolled };
  };
  const compose = () =>
    composing ??= (async () => {
      if (composed) return;
      const tenant = await runtime.grantedTenant();
      if (!tenant) return;
      if (!appBound) {
        await openReplicaApp(runtime.store, tenant, {
          requireReadScope: runtime.requireReadScope,
          prepareReadRoomScope: runtime.prepareReadRoomScope,
          requireScope: runtime.requireScope,
          prepareRoomScope: runtime.prepareRoomScope,
          keyDocument: runtime.keyDocument,
          publicRooms: runtime.publicRooms,
          passwordLogin: runtime.passwordLogin,
          keys: await runtime.verificationKeys(),
          signer: await runtime.requestSigner(),
          deviceLists: runtime.deviceLists,
          sender: runtime.sender,
          releaseServices: runtime.releaseServices,
          ingress: runtime.ingress,
          profileFanout: runtime.profileFanout,
        });
      }
      appBound = true;
      const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });
      const handle: Deno.ServeHandler = async (request, info) => {
        let required: Scope | undefined;
        const blocked = runtime.capabilities.gate(request, (scope) => {
          required = scope;
          return true;
        });
        if (blocked) {
          return blocked;
        }
        try {
          if (!await runtime.grantedTenant()) {
            throw new MatrixError(
              503,
              'M_UNAVAILABLE',
              'facade is not enrolled',
            );
          }
          if (!composed) {
            throw new MatrixError(
              503,
              'M_UNAVAILABLE',
              'replica listener not ready',
            );
          }
          if (required === 'public' || required === 'rooms') {
            await runtime.requireScope('directory');
            if (
              !(await federationPolicy(runtime.server)).enabled
            ) {
              throw new MatrixError(
                404,
                'M_UNRECOGNIZED',
                'federation disabled',
              );
            }
          }
          if (required === 'keys') {
            await runtime.keyDocument();
          }
          return await matrix(request, info);
        } catch (error) {
          if (error instanceof MatrixError || error instanceof LinkError) {
            if (!(error instanceof MatrixError) || error.status >= 500) {
              requestFailure(request, error);
            }
            return Response.json(
              error instanceof MatrixError ? error.responseBody() : {
                errcode: 'M_UNAVAILABLE',
                error: 'facade authority unavailable',
              },
              { status: error instanceof MatrixError ? error.status : 503 },
            );
          }
          throw error;
        }
      };
      servers.push(
        Deno.serve(
          { port: appPort(), signal: lifetime.controller.signal },
          lifetime.wrap('cs', handle),
        ),
      );
      if (config().federation.enabled) {
        const { port, cert, key } = config().federation;
        servers.push(
          Deno.serve({
            port,
            cert: await Deno.readTextFile(cert),
            key: await Deno.readTextFile(key),
            signal: lifetime.controller.signal,
          }, lifetime.wrap('federation', handle)),
        );
      }
      composed = true;
    })().catch(async (error) => {
      // Composition is startup, even when enrollment triggers it later. A
      // configured listener failure must not become retryable link traffic.
      compositionFailed = true;
      if (link) {
        // The process owner aborts and closes the whole running facade. Do not
        // close a partial listener here first and leave its abort hook dangling.
        fail(error);
      } else {
        await Promise.all(servers.splice(0).map((server) => server.shutdown()));
      }
      throw error;
    }).finally(() => {
      if (!compositionFailed) composing = undefined;
    });
  try {
    await compose();
    link = await startLinkTransport({
      hostname: '0.0.0.0',
      port: config().facade.linkport,
      tls: runtime.tls,
      authorize: runtime.authorize,
      handle: async (request, pin) => {
        const response = await runtime.handle(request, pin);
        await compose();
        return response;
      },
    });
    const admin = await startAdminHandler(
      operationHandler({
        ...facadeOperations({
          role: 'facade',
          pairings: runtime.pairings,
          initialize: runtime.initialize,
          status,
          progress: runtime.progress,
          tenant: runtime.grantedTenant,
          changed: async () => {
            await runtime.changed();
            await compose();
          },
        }),
        '/v1/status': status,
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
          await Promise.all(servers.map((server) => server.shutdown()));
          await runtime.close();
          if (appBound) await closeApp();
        })();
      },
    };
  } catch (error) {
    await link?.close();
    await Promise.all(servers.map((server) => server.shutdown()));
    await runtime.close();
    if (appBound) await closeApp();
    throw error;
  }
}
