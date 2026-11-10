// Matrix identifiers have a sigil and localpart before the first colon;
// everything after it is the server name, including any port or IPv6 literal.
// Splitting is pure structure, not validation: callers keep their existing
// sigil, locality, malformed-input and authorization checks.
export function splitId(
  id: string,
): { localpart: string; server: string | null } {
  const colon = id.indexOf(':');
  return {
    localpart: colon < 0 ? id.slice(1) : id.slice(1, colon),
    server: colon < 0 ? null : id.slice(colon + 1),
  };
}

/** The localpart of a full Matrix identifier, excluding its sigil. */
export function localpartOf(id: string): string {
  return splitId(id).localpart;
}

/** Preserve federation's existing domainOf contract for unqualified ids. */
export function domainOf(id: string): string {
  const { server } = splitId(id);
  return server === null ? id : server;
}

// Event-context identifiers include historical accounts, not just names a
// server may create today (appendices: Historical User IDs). Do not use this
// to validate new local account names or non-event device-list forwarding.
const HISTORICAL_USER =
  /^@[^:\uD800-\uDFFF]*:(\[[0-9A-Fa-f:.]+\]|[0-9A-Za-z.-]+)(:[0-9]{1,5})?$/u;
export function validEventUserId(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0') &&
    HISTORICAL_USER.exec(value)?.[0] === value &&
    new TextEncoder().encode(value).length <= 255;
}
