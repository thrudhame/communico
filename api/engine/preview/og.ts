// Website markup belongs to its parser/encoding standards, not a tag regex.
// The guard bounds input bytes; parsing never executes scripts or fetches URLs.
import { type DefaultTreeAdapterTypes, parse } from 'parse5';
import sniffEncoding from 'html-encoding-sniffer';
import { decode, getBOMEncoding, labelToName } from 'whatwg-encoding';
import { SaxesParser } from 'saxes';
import { fieldText, mediaType } from '#engine/net/fields.ts';
import { protocol } from '#engine/net/upstream-error.ts';

export function decodeHtmlBody(body: Uint8Array, contentType: string): string {
  const label = mediaType(contentType).parameters.get('charset')?.[0];
  // WHATWG order: BOM, supported transport label, 1024-byte meta prescan,
  // then the HTML fallback (windows-1252). The prescan owns pragma/label rules.
  return decode(
    body,
    sniffEncoding(body, { transportLayerEncodingLabel: label }),
  );
}

function metadata() {
  const og: Record<string, string> = {};
  let title: string | null = null, description: string | null = null;
  return {
    title(text: string) {
      if (title === null && text.trim()) title = text.trim();
    },
    meta(attrs: Record<string, string>) {
      const content = attrs.content?.trim();
      const key = (attrs.property ?? attrs.name)?.trim().toLowerCase();
      if (!content || !key) return;
      if (key.startsWith('og:')) {
        if (!Object.hasOwn(og, key)) og[key] = content;
      } else if (key === 'description' && description === null) {
        description = content;
      }
    },
    result() {
      if (!Object.hasOwn(og, 'og:title') && title !== null) {
        og['og:title'] = title;
      }
      if (!Object.hasOwn(og, 'og:description') && description !== null) {
        og['og:description'] = description;
      }
      return og;
    },
  };
}

export function parseOpenGraph(html: string): Record<string, string> {
  const out = metadata();
  const stack: DefaultTreeAdapterTypes.Node[] = [parse(html)];
  while (stack.length) {
    const node = stack.pop()!;
    if (
      'tagName' in node && node.namespaceURI === 'http://www.w3.org/1999/xhtml'
    ) {
      if (node.tagName === 'title') {
        out.title(
          node.childNodes.filter((n) => n.nodeName === '#text')
            .map((n) => (n as DefaultTreeAdapterTypes.TextNode).value).join(''),
        );
      } else if (node.tagName === 'meta') {
        // HTML applies first-attribute-wins and decodes character references
        // exactly once, with proper quoted/unquoted and rawtext states.
        out.meta(Object.fromEntries(node.attrs.map((a) => [a.name, a.value])));
      }
    }
    // Template contents live in a separate fragment and are not page metadata.
    if ('childNodes' in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) {
        stack.push(node.childNodes[i]);
      }
    }
  }
  return out.result();
}

function xmlDeclarationEncoding(body: Uint8Array): string | undefined {
  if (
    body[0] !== 60 || body[1] !== 63 || body[2] !== 120 ||
    body[3] !== 109 || body[4] !== 108 ||
    ![9, 10, 13, 32].includes(body[5])
  ) return undefined;
  // Only the declaration prefix uses ASCII-compatible byte text. The document
  // is decoded once below in its selected encoding. The existing input budget
  // also bounds a long declaration; there is no independent declaration quota.
  let end = 6;
  while (end < body.length && body[end] !== 63) end++;
  return /^<\?xml\s[^?]*\bencoding\s*=\s*['"]([^'"]+)['"]/.exec(
    fieldText(body.subarray(0, end)),
  )?.[1];
}

function xhtmlGraph(
  body: Uint8Array,
  contentType: string,
): Record<string, string> {
  const label = mediaType(contentType).parameters.get('charset')?.[0];
  const bom: string | null = getBOMEncoding(body);
  // XML uses a declaration/default UTF8, never an HTML meta/windows1252 fallback.
  const wide = body[0] === 0 && body[1] === 60
    ? 'UTF-16BE'
    : body[0] === 60 && body[1] === 0
    ? 'UTF-16LE'
    : null;
  const declaration = bom || label !== undefined || wide
    ? undefined
    : xmlDeclarationEncoding(body);
  const selected = bom ?? (label === undefined ? null : labelToName(label)) ??
    wide ?? (declaration === undefined ? 'UTF-8' : labelToName(declaration));
  if (
    !selected || (label !== undefined && !bom && labelToName(label) === null)
  ) protocol('preview-xml', 'unsupported XML encoding');
  const out = metadata();
  const parser = new SaxesParser({ xmlns: true });
  const htmlNamespace = 'http://www.w3.org/1999/xhtml';
  let titleDepth = 0, title = '', depth = 0;
  parser.on(
    'error',
    (cause) => protocol('preview-xml', 'malformed XHTML', cause),
  );
  parser.on('opentag', (node) => {
    depth++;
    if (node.uri !== htmlNamespace) return;
    if (node.local === 'meta') {
      out.meta(Object.fromEntries(
        Object.values(node.attributes).filter((a) => a.uri === '').map(
          (a) => [a.local, a.value],
        ),
      ));
    }
    if (node.local === 'title' && titleDepth === 0) {
      titleDepth = depth;
      title = '';
    }
  });
  const text = (value: string) => {
    if (titleDepth) title += value;
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    if (titleDepth === depth) {
      out.title(title);
      titleDepth = 0;
    }
    depth--;
  });
  // No external entity/DTD resolver: preview parsing has no network authority.
  let xml: string;
  try {
    xml = new TextDecoder(selected, { fatal: true }).decode(body);
  } catch (cause) {
    protocol('preview-xml', 'invalid or unsupported XML encoding', cause);
  }
  parser.write(xml).close();
  return out.result();
}

export function openGraphFor(
  body: Uint8Array,
  contentType: string,
  url: string,
): Record<string, string> {
  const mime = mediaType(contentType).value;
  if (mime.startsWith('image/')) return { 'og:image': url };
  if (mime === 'application/xhtml+xml') return xhtmlGraph(body, contentType);
  if (mime !== 'text/html') return {};
  return parseOpenGraph(decodeHtmlBody(body, contentType));
}
