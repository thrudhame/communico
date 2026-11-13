// tests/preview-og.test.ts — OG scanner shapes (plan D6). Pure.
import { assert, assertEquals } from '@std/assert';
import { openGraphFor, parseOpenGraph } from '#engine/preview/og.ts';

Deno.test('og: property and name, attribute order, quotes, self-closing, multiline', () => {
  const html = `
<title>The Rock (1996)</title>
<meta content="The Rock" property="og:title" />
<meta name='og:type' content='video.movie'>
<meta property=og:url content="http://www.imdb.com/title/tt0117500/">
<meta property=og:site_name content=IMDb>
<meta
  property="og:image"
  content="test.png"
>
`;
  const og = parseOpenGraph(html);
  assertEquals(og['og:title'], 'The Rock');
  assertEquals(og['og:type'], 'video.movie');
  assertEquals(og['og:url'], 'http://www.imdb.com/title/tt0117500/');
  assertEquals(og['og:site_name'], 'IMDb');
  assertEquals(og['og:image'], 'test.png');
});

Deno.test('og: title and description fill only when og:* absent; first og wins', () => {
  const html = `
<title> The Rock (1996) </title>
<meta name="description" content="A film">
<meta property="og:title" content="first">
<meta property="og:title" content="second">
`;
  const og = parseOpenGraph(html);
  assertEquals(og['og:title'], 'first');
  assertEquals(og['og:description'], 'A film');
  const fromTitle = parseOpenGraph(
    '<title> The Rock (1996) </title>',
  );
  assertEquals(fromTitle['og:title'], 'The Rock (1996)');
});

Deno.test('og: HTML entities decoded and trimmed', () => {
  const og = parseOpenGraph(
    '<meta property="og:title" content="  Tom &amp; Jerry &quot;quoted&#39;  ">',
  );
  assertEquals(og['og:title'], 'Tom & Jerry "quoted\'');
});

Deno.test('og: image content-type is the URL; other types empty; html parsed', () => {
  const bytes = new TextEncoder().encode(
    '<meta property="og:title" content="Hi">',
  );
  assertEquals(
    openGraphFor(bytes, 'image/png', 'http://x/a.png'),
    { 'og:image': 'http://x/a.png' },
  );
  assertEquals(openGraphFor(bytes, 'application/pdf', 'http://x/a.pdf'), {});
  assertEquals(
    openGraphFor(bytes, 'text/html; charset=utf-8', 'http://x/'),
    { 'og:title': 'Hi' },
  );
});

Deno.test('og: XHTML declaration sniffing only allocates its byte prefix', () => {
  const declaration = '<?xml version="1.0" encoding="iso-8859-1"?>';
  const xml = declaration +
    '<html xmlns="http://www.w3.org/1999/xhtml"><title>caf\u00e9</title>' +
    ' '.repeat(128 * 1024) + '</html>';
  let iterated = 0;
  class ObservedBytes extends Uint8Array {
    override *[Symbol.iterator](): ArrayIterator<number> {
      iterated += this.length;
      yield* super[Symbol.iterator]();
    }
  }
  const body = ObservedBytes.from(xml, (c) => c.charCodeAt(0));
  assertEquals(openGraphFor(body, 'application/xhtml+xml', 'http://x/'), {
    'og:title': 'caf\u00e9',
  });
  assert(
    iterated <= declaration.length,
    'declaration sniff iterated body bytes',
  );
});

Deno.test('og: XHTML declarations have no independent length quota', () => {
  const xml = '<?xml version="1.0"' + ' '.repeat(16 * 1024) +
    'encoding="iso-8859-1"?><html xmlns="http://www.w3.org/1999/xhtml"><title>caf\u00e9</title></html>';
  assertEquals(
    openGraphFor(
      Uint8Array.from(xml, (c) => c.charCodeAt(0)),
      'application/xhtml+xml',
      'http://x/',
    ),
    { 'og:title': 'caf\u00e9' },
  );
});
