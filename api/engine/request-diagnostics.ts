// The application-owned HTTP failure disclosure boundary. One atomic record
// keeps concurrent requests correlated, without serializing request objects or
// arbitrary exception properties/causes that may carry private payloads.
import { accessLogPath } from './access-log.ts';

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
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : {
          name: 'NonError',
          message: 'non-Error exception (' + typeof error + ')',
        },
    }),
  );
}
