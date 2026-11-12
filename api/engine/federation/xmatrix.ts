// api/engine/federation/xmatrix.ts — the X-Matrix authorization scheme:
// build for outbound, parse for inbound. Grammar per spec (SS:313-319,
// 352-373): origin, destination, key, and a signature under param `sig`
// OR `signature` (the spec's example says sig, its parameter list says
// signature; gmsl reads sig). RFC 9110 §11.4 auth params: quoted or
// token values, backslash unescape, case-insensitive names, unknown
// params ignored. A request MAY carry several
// Authorization headers — the parser returns ALL usable ones.
import { fieldList, parameterized, TOKEN } from '#engine/net/fields.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
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
// Headers can join several schemes. Only commas outside quoted strings can
// separate parameters or schemes; an unterminated string cannot be recovered by
// treating its contents as a fresh credential.
function commaFields(raw: string): string[] | null {
  try {
    return fieldList(raw, 'x-matrix');
  } catch (error) {
    if (!(error instanceof UpstreamError) || error.category !== 'protocol') {
      throw error;
    }
    return null;
  }
}

function candidate(fields: string[]): XMatrixParams | null {
  const params = new Map<string, string>();
  try {
    for (const field of fields) {
      // Reuse the token/quoted-pair grammar, with exactly one auth-param per
      // comma field. A semicolon must not become an alternate list delimiter.
      const parsed = parameterized('auth;' + field, 'x-matrix').parameters;
      if (parsed.size !== 1) return null;
      const [name, values] = [...parsed][0];
      if (values.length !== 1 || params.has(name)) return null;
      params.set(name, values[0]);
    }
  } catch (error) {
    if (!(error instanceof UpstreamError) || error.category !== 'protocol') {
      throw error;
    }
    return null;
  }
  const origin = params.get('origin'), key = params.get('key');
  const sig = params.get('sig'), signature = params.get('signature');
  if (sig !== undefined && signature !== undefined && sig !== signature) {
    return null;
  }
  const value = sig === undefined ? signature : sig;
  if (!origin || !key || !value) return null;
  const destination = params.get('destination');
  return {
    origin,
    key,
    signature: value,
    destination: destination === undefined || destination === ''
      ? null
      : destination,
  };
}

export function parseXMatrixHeaders(all: string[]): XMatrixParams[] {
  const out: XMatrixParams[] = [];
  for (const header of all) {
    const fields = commaFields(header);
    if (fields === null) continue;
    let active = false, params: string[] = [];
    const finish = () => {
      const value = active ? candidate(params) : null;
      if (value !== null) out.push(value);
    };
    for (const field of fields) {
      if (!field) continue; // RFC9110 list recipients tolerate empty elements.
      const scheme = /^([^ \t]+) +(.+)$/.exec(field);
      if (
        scheme !== null && TOKEN.test(scheme[1]) && !/^[ \t]*=/.test(scheme[2])
      ) {
        finish();
        active = scheme[1].toLowerCase() === 'x-matrix';
        params = [scheme[2]];
      } else params.push(field);
    }
    finish();
  }
  return out;
}
