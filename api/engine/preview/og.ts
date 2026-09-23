// api/engine/preview/og.ts — Open Graph from HTML (Synapse
// media/preview_html.py, scoped). A <meta>/<title> scanner: tags may
// span lines, attributes any order, single/double/no quotes,
// self-closing. First occurrence wins. Entity-decode via @std/html.
import { unescape } from '@std/html';

function charsetFromContentType(contentType: string): string | null {
  const m = /;\s*charset\s*=\s*"?([a-z0-9._-]+)"?/i.exec(contentType);
  if (m === null) return null;
  return m[1].toLowerCase();
}

function charsetFromMeta(bytes: Uint8Array): string | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  const m = /<\s*meta[^>]*charset\s*=\s*"?([a-z0-9._-]+)"?/i.exec(head);
  if (m === null) return null;
  return m[1].toLowerCase();
}

export function decodeHtmlBody(
  body: Uint8Array,
  contentType: string,
): string {
  const fromHeader = charsetFromContentType(contentType);
  const fromMeta = charsetFromMeta(body);
  const charset = fromHeader !== null
    ? fromHeader
    : fromMeta !== null
    ? fromMeta
    : 'utf-8';
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (i >= raw.length || raw[i] === '/' || raw[i] === '>') break;
    const nameStart = i;
    while (i < raw.length && /[^\s=/>]/.test(raw[i])) i++;
    const name = raw.slice(nameStart, i).toLowerCase();
    if (name.length === 0) {
      i++;
      continue;
    }
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (i < raw.length && raw[i] === '=') {
      i++;
      while (i < raw.length && /\s/.test(raw[i])) i++;
      let value = '';
      if (i < raw.length && (raw[i] === '"' || raw[i] === "'")) {
        const q = raw[i];
        i++;
        const start = i;
        while (i < raw.length && raw[i] !== q) i++;
        value = raw.slice(start, i);
        if (i < raw.length) i++;
      } else {
        const start = i;
        while (i < raw.length && !/[\s/>]/.test(raw[i])) i++;
        value = raw.slice(start, i);
      }
      out[name] = unescape(value).trim();
    } else {
      out[name] = '';
    }
  }
  return out;
}

export function parseOpenGraph(html: string): Record<string, string> {
  const og: Record<string, string> = {};
  let titleText: string | null = null;
  let description: string | null = null;
  const tagRe = /<\s*(meta|title)(\s[^>]*)?>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    if (tag === 'title') {
      if (titleText !== null) continue;
      const rest = html.slice(m.index + m[0].length);
      const end = rest.search(/<\s*\/\s*title\s*>/i);
      if (end < 0) continue;
      const text = unescape(rest.slice(0, end)).trim();
      if (text.length > 0) titleText = text;
      continue;
    }
    const attrs = parseAttrs(m[2] !== undefined ? m[2] : '');
    const content = attrs.content;
    if (content === undefined || content.length === 0) continue;
    const prop = attrs.property !== undefined ? attrs.property : attrs.name;
    if (prop === undefined) continue;
    const key = prop.toLowerCase();
    if (key.startsWith('og:')) {
      if (!Object.hasOwn(og, key)) og[key] = content;
      continue;
    }
    if (key === 'description' && description === null) {
      description = content;
    }
  }
  if (!Object.hasOwn(og, 'og:title') && titleText !== null) {
    og['og:title'] = titleText;
  }
  if (!Object.hasOwn(og, 'og:description') && description !== null) {
    og['og:description'] = description;
  }
  return og;
}

export function openGraphFor(
  body: Uint8Array,
  contentType: string,
  url: string,
): Record<string, string> {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (mime.startsWith('image/')) {
    return { 'og:image': url };
  }
  if (mime !== 'text/html' && mime !== 'application/xhtml+xml') {
    return {};
  }
  return parseOpenGraph(decodeHtmlBody(body, contentType));
}
