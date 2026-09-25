// api/engine/federation/xmatrix.ts — the X-Matrix authorization scheme:
// build for outbound, parse for inbound. Grammar per spec (SS:313-319,
// 352-373): origin, destination, key, and a signature under param `sig`
// OR `signature` (the spec's example says sig, its parameter list says
// signature; gmsl reads sig). RFC 9110 §11.4 auth params: quoted or
// token values, backslash unescape, case-insensitive names, unknown
// params ignored, unquoted colons tolerated. A request MAY carry several
// Authorization headers — the parser returns ALL usable ones.
export type XMatrixParams = {
  origin: string;
  destination: string | null;
  key: string;
  signature: string;
};

function escapeQuoted(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export function buildXMatrixHeader(p: XMatrixParams): string {
  const parts = [
    'origin="' + escapeQuoted(p.origin) + '"',
    p.destination !== null
      ? 'destination="' + escapeQuoted(p.destination) + '"'
      : null,
    'key="' + escapeQuoted(p.key) + '"',
    'sig="' + escapeQuoted(p.signature) + '"',
  ];
  return 'X-Matrix ' + parts.filter((x) => x !== null).join(',');
}

// Parse the auth-param list after the X-Matrix scheme token: k=v pairs,
// values quoted with backslash escapes or bare tokens. Windows-style
// backslashes survive: escaped pairs are unescaped one level.
function parseAuthParams(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let rest = raw.trim();
  while (rest.length > 0) {
    const eq = rest.indexOf('=');
    if (eq < 0) break;
    let name = '';
    for (const ch of rest.slice(0, eq)) {
      if (ch !== ',') name += ch;
    }
    name = name.trim().toLowerCase();
    rest = rest.slice(eq + 1).trimStart();
    let value = '';
    if (rest.startsWith('"')) {
      let i = 1;
      while (i < rest.length) {
        const ch = rest[i];
        if (ch === '\\' && i + 1 < rest.length) {
          value += rest[i + 1];
          i += 2;
        } else if (ch === '"') {
          i++;
          break;
        } else {
          value += ch;
          i++;
        }
      }
      rest = rest.slice(i);
    } else {
      let i = 0;
      while (i < rest.length && rest[i] !== ',') {
        value += rest[i];
        i++;
      }
      rest = rest.slice(i);
      value = value.trim();
    }
    if (name.length > 0 && out[name] === undefined) out[name] = value;
    const comma = rest.indexOf(',');
    rest = comma < 0 ? '' : rest.slice(comma + 1).trim();
  }
  return out;
}

export function parseXMatrixHeaders(all: string[]): XMatrixParams[] {
  const out: XMatrixParams[] = [];
  for (const header of all) {
    const space = header.indexOf(' ');
    if (space < 0) continue;
    if (header.slice(0, space).toLowerCase() !== 'x-matrix') continue;
    const params = parseAuthParams(header.slice(space + 1));
    const sig = params.sig !== undefined ? params.sig : params.signature;
    if (
      typeof params.origin === 'string' && params.origin.length > 0 &&
      typeof sig === 'string' && sig.length > 0 &&
      typeof params.key === 'string' && params.key.length > 0
    ) {
      out.push({
        origin: params.origin,
        destination: typeof params.destination === 'string' &&
            params.destination.length > 0
          ? params.destination
          : null,
        key: params.key,
        signature: sig,
      });
    }
  }
  return out;
}
