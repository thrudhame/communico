// The application-owned failure disclosure boundary. One atomic record
// keeps concurrent failures correlated, without serializing request objects or
// arbitrary exception properties/causes that may carry private payloads.
import { HttpError } from '@pathfinder/pathfinder';
import { accessLogPath } from './access-log.ts';
import { LinkError } from './facade/protocol.ts';
import { MatrixError } from './matrix-error.ts';

function safeException(error: unknown) {
  return error instanceof Error
    ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(error instanceof HttpError || error instanceof LinkError
        ? { status: error.status }
        : {}),
      ...(error instanceof MatrixError ? { errcode: error.errcode } : {}),
      ...(error instanceof LinkError ? { code: error.code } : {}),
    }
    : {
      name: 'NonError',
      message: 'non-Error exception (' + typeof error + ')',
    };
}

export function requestFailure(
  request: { method?: string; url?: string },
  error: unknown,
): void {
  let path = '[REDACTED-PATH]';
  try {
    const target = request.url ?? '/';
    path = accessLogPath(
      target.startsWith('/') ? target : new URL(target).pathname,
    );
  } catch {
    // Malformed request targets cannot make the error handler fail or expose
    // their original bytes as a diagnostic fallback.
  }
  console.error(
    'http failure: ' + JSON.stringify({
      method: request.method ?? 'UNKNOWN',
      path,
      error: safeException(error),
    }),
  );
}

/** Inbox context is an explicit projection, never a record, grant or tenant.
 * Readiness describes the runtime's local prerequisites, not a new authority
 * lookup after the failing apply cut. Stream names identify the affected domain,
 * room or account without reading the private journal payload. */
export function inboxFailure(
  context: {
    server: string;
    node: string;
    peer: string;
    initialized: boolean;
    tenantAvailable: boolean;
    phase: string;
  },
  error: unknown,
  stream?: { source: string; incarnation: string; stream: string },
  after?: number,
): void {
  console.error(
    'inbox failure: ' + JSON.stringify({
      server: context.server,
      node: context.node,
      peer: context.peer,
      stream: stream
        ? {
          source: stream.source,
          incarnation: stream.incarnation,
          stream: stream.stream,
        }
        : null,
      after: after ?? null,
      readiness: {
        initialized: context.initialized,
        tenantAvailable: context.tenantAvailable,
        phase: context.phase,
      },
      error: safeException(error),
    }),
  );
}
