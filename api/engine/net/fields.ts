import { protocol } from './upstream-error.ts';

export const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export function trimOws(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, '');
}
// RFC9110 comma lists share quoted-string boundaries, including quoted-pairs.
// Callers own each element's grammar and duplicate semantics.
export function fieldList(raw: string, phase = 'http-field'): string[] {
  const out: string[] = [];
  let quoted = false, start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (quoted && raw[i] === '\\') {
      i++;
      continue;
    }
    if (raw[i] === '"') quoted = !quoted;
    else if (!quoted && raw[i] === ',') {
      out.push(trimOws(raw.slice(start, i)));
      start = i + 1;
    }
  }
  if (quoted) protocol(phase, 'unterminated quoted field');
  out.push(trimOws(raw.slice(start)));
  return out;
}
// Headers uses ByteString, not TextDecoder('latin1')'s Windows-1252 mapping.
export function fieldText(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => String.fromCharCode(b)).join('');
}
export function field(line: string, phase = 'http-head'): [string, string] {
  const colon = line.indexOf(':');
  const name = line.slice(0, colon);
  const value = line.slice(colon + 1);
  if (colon < 1 || !TOKEN.test(name) || /[^\t\x20-\x7e\x80-\xff]/.test(value)) {
    protocol(phase, 'bad upstream header');
  }
  return [name.toLowerCase(), trimOws(value)];
}
// RFC9110 parameter grammar, including quoted-pairs. Callers own singleton
// semantics; unknown/extension parameters are not a reason to reject a field.
export function parameterized(raw: string, phase = 'media-type'): {
  value: string;
  parameters: Map<string, string[]>;
} {
  let at = raw.indexOf(';');
  const value = trimOws(at < 0 ? raw : raw.slice(0, at));
  const parameters = new Map<string, string[]>();
  if (!value) protocol(phase, 'empty field value');
  if (at < 0) return { value, parameters };
  const ows = () => {
    while (raw[at] === ' ' || raw[at] === '\t') at++;
  };
  const token = () => {
    const start = at;
    while (at < raw.length && TOKEN.test(raw[at])) at++;
    if (at === start) protocol(phase, 'invalid field parameter');
    return raw.slice(start, at);
  };
  while (at < raw.length) {
    if (raw[at++] !== ';') protocol(phase, 'invalid field parameter');
    ows();
    const name = token().toLowerCase();
    ows();
    if (raw[at++] !== '=') protocol(phase, 'invalid field parameter');
    ows();
    let text = '';
    if (raw[at] === '"') {
      at++;
      let closed = false;
      while (at < raw.length) {
        const c = raw[at++];
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\\') {
          const escaped = raw[at++];
          if (
            escaped === undefined || !/^[\t\x20-\x7e\x80-\xff]$/.test(escaped)
          ) protocol(phase, 'invalid quoted-pair');
          text += escaped;
        } else {
          if (!/^[\t\x20-\x21\x23-\x5b\x5d-\x7e\x80-\xff]$/.test(c)) {
            protocol(phase, 'invalid quoted field');
          }
          text += c;
        }
      }
      if (!closed) protocol(phase, 'unterminated quoted field');
    } else text = token();
    const present = parameters.get(name);
    const list = present === undefined ? [] : present;
    list.push(text);
    parameters.set(name, list);
    ows();
  }
  return { value, parameters };
}
export function mediaType(raw: string): ReturnType<typeof parameterized> {
  const parsed = parameterized(raw);
  const parts = parsed.value.split('/');
  if (parts.length !== 2 || !parts.every((p) => TOKEN.test(p))) {
    protocol('media-type', 'invalid media type');
  }
  parsed.value = parsed.value.toLowerCase();
  return parsed;
}
