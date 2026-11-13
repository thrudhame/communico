import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { sendGateway } from '#engine/push/transport.ts';
import {
  decodeHtmlBody,
  openGraphFor,
  parseOpenGraph,
} from '#engine/preview/og.ts';
import { guardedGet } from '#engine/preview/guard.ts';
import {
  UpstreamError,
  UpstreamHttpError,
} from '#engine/net/upstream-error.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const policy = { blocklist: [], allowlist: [], caCerts: [], timeoutMs: 1000 };

Deno.test('ancillary: push JSON media/UTF8/schema errors retain protocol provenance, no retry', async (t) => {
  for (
    const [type, body] of [
      ['text/plain', bytes('{"rejected":["key"]}')],
      [
        'application/json',
        new Uint8Array([...bytes('{"rejected":["'), 255, ...bytes('"]}')]),
      ],
      ['application/json', bytes('{"rejected":false}')],
      ['application/json', bytes('null')],
      ['application/json', bytes('{')],
    ] as const
  ) {
    await t.step(type + ':' + body.length, async () => {
      let calls = 0;
      const error = await assertRejects(
        () =>
          sendGateway(
            'https://gateway.test/_matrix/push/v1/notify',
            {},
            new AbortController().signal,
            policy,
            {
              resolve: () => Promise.resolve(['8.8.8.8']),
              dial: () => {
                calls++;
                return Promise.resolve({
                  status: 200,
                  headers: new Headers({ 'content-type': type }),
                  body,
                });
              },
            },
          ),
        UpstreamError,
      );
      assertEquals(error.category, 'protocol');
      assertEquals(calls, 1);
    });
  }
});

Deno.test('ancillary: push valid extension verdict, completed refusal, local fault and cancellation', async () => {
  const signal = new AbortController().signal;
  const url = 'https://gateway.test/_matrix/push/v1/notify';
  const resolve = () => Promise.resolve(['8.8.8.8']);
  assertEquals(
    await sendGateway(url, {}, signal, policy, {
      resolve,
      dial: () =>
        Promise.resolve({
          status: 200,
          headers: new Headers({
            'content-type': 'Application/JSON; charset="utf-8"',
          }),
          body: bytes(' \r\n{"rejected":["key"],"extension":true} '),
        }),
    }),
    ['key'],
  );
  const error = await assertRejects(() =>
    sendGateway(url, {}, signal, policy, {
      resolve,
      dial: () =>
        Promise.resolve({
          status: 503,
          headers: new Headers(),
          body: bytes('private'),
        }),
    }), UpstreamHttpError);
  assertEquals(error.remoteStatus, 503);
  const fault = new Error('local fault');
  assertEquals(
    await assertRejects(() =>
      sendGateway(url, {}, signal, policy, {
        resolve: () => Promise.reject(fault),
      })
    ),
    fault,
  );
  const abort = new AbortController();
  abort.abort(fault);
  assertEquals(
    await assertRejects(() => sendGateway(url, {}, abort.signal, policy)),
    fault,
  );
});

Deno.test('ancillary: HTML parser honors comments, rawtext, quoted delimiters, RCDATA and duplicate attributes', () => {
  assertEquals(
    parseOpenGraph(`
    <!-- <meta property="og:title" content="comment"> -->
    <script>const x = '<meta property="og:title" content="script">';</script>
    <style>p:after { content: '<meta property="og:title" content="style">' }</style>
    <textarea><meta property="og:title" content="textarea"></textarea>
    <template><meta property="og:title" content="template"></template>
    <meta property="og:title" content="A > B &amp; C" content="last">
    <meta name="description" content="&amp;lt;literal&amp;gt;">
  `),
    { 'og:title': 'A > B & C', 'og:description': '&lt;literal&gt;' },
  );
  assertEquals(
    parseOpenGraph(
      '<title>A &lt;meta property="og:title" content="fake"&gt; &amp; B</title>',
    ),
    {
      'og:title': 'A <meta property="og:title" content="fake"> & B',
    },
  );
});

Deno.test('ancillary: HTML encoding sniffing prioritizes BOM and valid transport then meta pragma then fallback', () => {
  const utf8 = new Uint8Array([
    239,
    187,
    191,
    ...bytes('<title>caf\u00e9</title>'),
  ]);
  assertEquals(
    decodeHtmlBody(utf8, 'text/html; charset=windows-1252'),
    '<title>caf\u00e9</title>',
  );
  const latin = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  assertEquals(
    decodeHtmlBody(
      latin(
        "<!-- <meta charset=utf-8> --><meta charset='windows-1252'><title>caf\u00e9</title>",
      ),
      'text/html; charset=invalid',
    ),
    "<!-- <meta charset=utf-8> --><meta charset='windows-1252'><title>caf\u00e9</title>",
  );
  assertEquals(
    decodeHtmlBody(
      latin(
        '<meta content="text/html; charset=windows-1252" http-equiv="content-type"><title>caf\u00e9</title>',
      ),
      'text/html',
    ).includes('caf\u00e9'),
    true,
  );
  assertEquals(
    decodeHtmlBody(
      latin(
        '<meta content="text/html; charset=utf-8"><title>caf\u00e9</title>',
      ),
      'text/html',
    ).includes('caf\u00e9'),
    true,
    'content charset without pragma must not select UTF8',
  );
  assertEquals(
    decodeHtmlBody(latin('<title>caf\u00e9</title>'), 'text/html'),
    '<title>caf\u00e9</title>',
  );
  const utf16 = new Uint8Array([
    255,
    254,
    ...Array.from('<title>caf\u00e9</title>').flatMap(
      (c) => [c.charCodeAt(0), 0],
    ),
  ]);
  assertEquals(
    decodeHtmlBody(utf16, 'text/html; charset=utf-8'),
    '<title>caf\u00e9</title>',
  );
});

Deno.test('ancillary: XHTML keeps XML namespaces, case, CDATA, encoding and well-formedness', () => {
  const xml =
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title><![CDATA[A > B & C]]></title><META property="og:title" content="wrong case"/><meta xmlns="urn:not-html" property="og:title" content="wrong namespace"/></head></html>';
  assertEquals(openGraphFor(bytes(xml), 'application/xhtml+xml', 'http://x/'), {
    'og:title': 'A > B & C',
  });
  assertThrows(
    () =>
      openGraphFor(
        bytes('<html><meta property=og:title content="bad"></html>'),
        'application/xhtml+xml',
        'http://x/',
      ),
    UpstreamError,
  );
  assertThrows(
    () =>
      openGraphFor(
        bytes('<html><title>&notdefined;</title></html>'),
        'application/xhtml+xml',
        'http://x/',
      ),
    UpstreamError,
  );
  const latin = Uint8Array.from(
    '<?xml version="1.0" encoding="iso-8859-1"?><html xmlns="http://www.w3.org/1999/xhtml"><title>caf\u00e9</title></html>',
    (c) => c.charCodeAt(0),
  );
  assertEquals(openGraphFor(latin, 'application/xhtml+xml', 'http://x/'), {
    'og:title': 'caf\u00e9',
  });
});

Deno.test('ancillary: preview redirects only defined redirect statuses and retains target query', async () => {
  const seen: string[] = [];
  const peer = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (req) => {
      const u = new URL(req.url);
      seen.push(u.pathname + u.search);
      if (u.pathname === '/final') return new Response('ok');
      return new Response(null, {
        status: Number(u.pathname.slice(1)),
        headers: { location: '/final?q=kept' },
      });
    },
  );
  const opts = {
    maxBytes: 1000,
    blocklist: [],
    allowlist: [],
    acceptLanguage: null,
  };
  const base = `http://127.0.0.1:${peer.addr.port}`;
  try {
    for (const status of [301, 302, 303, 307, 308]) {
      assertEquals(
        (await guardedGet(base + '/' + status, opts)).url,
        base + '/final?q=kept',
      );
    }
    const before = seen.length;
    const error = await assertRejects(
      () => guardedGet(base + '/304', opts),
      UpstreamHttpError,
    );
    assertEquals(error.remoteStatus, 304);
    assertEquals(seen.slice(before), ['/304']);
  } finally {
    await peer.shutdown();
  }
});
