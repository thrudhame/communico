// One local operation protocol, independent of tenant/role composition.
import { AdminError, type Operation } from './protocol.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { LinkError } from '#engine/facade/protocol.ts';

export function operationHandler(
  operations: Record<string, Operation>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const path = new URL(request.url).pathname;
      if (!Object.hasOwn(operations, path)) {
        throw new AdminError('NOT_FOUND', 'unknown admin operation', 404);
      }
      if (request.method !== 'POST') {
        throw new AdminError('METHOD_NOT_ALLOWED', 'use POST', 405);
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new AdminError('BAD_REQUEST', 'expected a JSON object');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new AdminError('BAD_REQUEST', 'expected a JSON object');
      }
      const result = await operations[path](body as Record<string, unknown>);
      return Response.json({
        ok: true,
        result: result === undefined ? null : result,
      });
    } catch (error) {
      const known = error instanceof AdminError ||
        error instanceof MatrixError || error instanceof LinkError;
      if (!known) console.error('admin:', error);
      return Response.json({
        ok: false,
        error: {
          code: error instanceof MatrixError
            ? error.errcode
            : error instanceof AdminError || error instanceof LinkError
            ? error.code
            : 'INTERNAL',
          message: known ? error.message : 'admin operation failed',
        },
      }, { status: known ? error.status : 500 });
    }
  };
}
