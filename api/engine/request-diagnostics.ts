// The application-owned failure disclosure boundary. One atomic record
// keeps concurrent failures correlated, without serializing request objects or
// arbitrary exception properties that may carry private payloads. Only Error
// causes/aggregate children cross the same explicit projection recursively.
import { HttpError } from '@pathfinder/pathfinder';
import type {
  Context,
  Middleware,
  PathfinderRequest,
} from '@pathfinder/pathfinder';
import { accessLogPath } from './access-log.ts';
import { LinkError } from './facade/protocol.ts';
import { MatrixError } from './matrix-error.ts';
import { UpstreamError } from './net/upstream-error.ts';

export function safeException(
  error: unknown,
  seen = new Set<Error>(),
): Record<string, unknown> {
  if (error instanceof Error) {
    if (seen.has(error)) {
      return { name: 'Circular', message: 'circular Error reference' };
    }
    seen.add(error);
  }
  return error instanceof Error
    ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
      // Peer decoder/socket causes may contain response bytes or credential
      // URLs. Preserve UpstreamError's existing explicit disclosure boundary.
      ...(error.cause instanceof Error && !(error instanceof UpstreamError)
        ? { cause: safeException(error.cause, seen) }
        : {}),
      ...(error instanceof AggregateError
        ? { errors: error.errors.map((child) => safeException(child, seen)) }
        : {}),
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

const diagnosed = new WeakMap<Context, unknown>();
export function matrixFailure(
  request: PathfinderRequest,
  context: Context,
): void {
  if (diagnosed.has(context) && diagnosed.get(context) === context.error) {
    return;
  }
  diagnosed.set(context, context.error);
  requestFailure(request._raw, context.error);
}

/** Includes typed HttpError 5xx, which bypass a 500 renderer. Unexpected
 * exceptions are recorded during rendering so a later post-function fault
 * cannot hide them. The context owns deduplication, never an exception object
 * shared by concurrent requests. Framework-internal catches remain raw logs. */
export const matrixDiagnostics: Middleware =
  (request, context) => (response) => {
    if (context.error !== undefined && response.status >= 500) {
      matrixFailure(request, context);
    }
  };

export function workerFailure(
  context: {
    owner: string;
    server: string;
    node?: string;
    peer?: string;
    scope?: string;
  },
  error: unknown,
): void {
  console.error(
    'worker failure: ' + JSON.stringify({
      owner: context.owner,
      server: context.server,
      node: context.node,
      peer: context.peer,
      scope: context.scope,
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
