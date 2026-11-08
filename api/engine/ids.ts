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
