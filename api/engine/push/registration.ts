import { MatrixError } from '#engine/matrix-error.ts';
import type { PusherInput } from '#engine/tenant/pushers.ts';

/** Registration parses configuration only. No DNS, gateway probe or TLS I/O. */
export function gatewayUrl(raw: unknown): URL {
  let url: URL;
  try {
    if (typeof raw !== 'string' || raw.length > 4096) throw new Error();
    url = new URL(raw);
    if (
      url.protocol !== 'https:' || url.username || url.password || url.hash ||
      url.pathname !== '/_matrix/push/v1/notify'
    ) throw new Error();
  } catch {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'HTTP pushers require an HTTPS /_matrix/push/v1/notify URL without credentials or a fragment',
    );
  }
  return url;
}

export function validatePusher(input: PusherInput): void {
  if (
    input.app_id.length > 64 ||
    new TextEncoder().encode(input.pushkey).length > 512 ||
    (input.append !== undefined && typeof input.append !== 'boolean')
  ) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'Invalid pusher identity or append value',
    );
  }
  if (input.kind === null) return;
  if (input.kind !== 'http') {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'Only HTTP pushers are supported; email notifications are not supported',
    );
  }
  if (
    !input.data || typeof input.data !== 'object' || Array.isArray(input.data)
  ) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'Pusher data must be an object',
    );
  }
  const data = input.data as Record<string, unknown>;
  gatewayUrl(data.url);
  if (data.format !== undefined && data.format !== 'event_id_only') {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'Unsupported pusher format');
  }
  if (new TextEncoder().encode(JSON.stringify(input.data)).length > 65536) {
    throw new MatrixError(400, 'M_TOO_LARGE', 'Pusher data exceeds 64 KiB');
  }
}
