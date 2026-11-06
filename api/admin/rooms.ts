import type { App } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import {
  dropOperatorRoom,
  listOperatorRooms,
  purgeOperatorRooms,
} from '#engine/room/operator.ts';
import {
  AdminError,
  flag,
  type Operation,
  text,
} from '#root/api/admin/protocol.ts';

export function roomOperations(app: App): Record<string, Operation> {
  return {
    '/v1/rooms/list': (body) => listOperatorRooms(app, flag(body, 'purgeable')),
    '/v1/rooms/drop': (body) => dropOperatorRoom(app, text(body, 'roomId')),
    '/v1/rooms/purge': (body) => {
      const olderThan = body.olderThan === undefined || body.olderThan === null
        ? null
        : body.olderThan;
      if (
        olderThan !== null &&
        (typeof olderThan !== 'number' || !Number.isFinite(olderThan))
      ) {
        throw new AdminError(
          'BAD_REQUEST',
          'olderThan must be finite milliseconds',
        );
      }
      return purgeOperatorRooms(app, olderThan as number | null);
    },
    '/v1/federation-cert/write': async () => {
      const { cert, key } = config().federation;
      try {
        return await app.tenant.writeFederationCert(cert, key);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith('refusing to overwrite existing ')
        ) throw new AdminError('EXISTS', error.message, 409);
        throw error;
      }
    },
  };
}
