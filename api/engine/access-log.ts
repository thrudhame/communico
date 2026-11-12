// The single access-log URL disclosure owner. Routing still receives the real
// request. Only the existing logger's view is sanitized, before either phase.
import { accessLog } from '@pathfinder/pathfinder/middleware';
import type { Middleware } from '@pathfinder/pathfinder';

const credentialLabels = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'logintoken',
  'registrationtoken',
  'clientsecret',
  'password',
  'secret',
]);
const delayedActions = new Set(['cancel', 'restart', 'send']);

export function accessLogPath(target: string): string {
  // Omit ALL query values, not a secret-name denylist. The current HTTP
  // adapter already omits queries; enforce that boundary for every caller.
  const path = target.split(/[?#]/, 1)[0];
  if (
    !path.startsWith('/') ||
    [...path].some((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  ) {
    return '[REDACTED-PATH]';
  }
  const raw = path.split('/');
  let decoded: string[];
  try {
    decoded = raw.map((segment) => decodeURIComponent(segment));
  } catch {
    return '[REDACTED-PATH]';
  }
  // Encoded query delimiters can carry a whole credential query inside a
  // nominal path segment. Never return that raw target as a logging fallback.
  // Encoded '#' remains valid in ordinary room aliases.
  if (decoded.some((segment) => segment.includes('?'))) {
    return '[REDACTED-PATH]';
  }
  for (let i = 0; i < decoded.length - 1; i++) {
    const label = decoded[i].replace(/[-_]/g, '').toLowerCase();
    const delayed = label === 'delayedevents';
    const invitation = decoded[i - 1] === 'state' &&
      decoded[i] === 'm.room.third_party_invite';
    if (!delayed && !invitation && !credentialLabels.has(label)) continue;
    if (raw[i + 1] === '' && i + 2 === raw.length) continue;
    const safe = [...raw.slice(0, i + 1), '[REDACTED]'];
    // Keep only a recognized action label, not an arbitrary suffix on a
    // miss that might be another piece of the same bearer credential.
    if (
      delayed && decoded.length === i + 3 && delayedActions.has(decoded[i + 2])
    ) {
      safe.push(decoded[i + 2]);
    }
    return safe.join('/');
  }
  return path;
}

const log = accessLog();
const safeAccessLog: Middleware = (request, context) => {
  const view = Object.create(request, {
    path: { value: accessLogPath(request.path), enumerable: true },
  });
  return log(view, context);
};
export default safeAccessLog;
