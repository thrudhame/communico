import { Buffer } from '@std/io';
import { sprintf } from '@std/fmt/printf';
import { format } from '@std/fmt/duration';
import { assert } from 'node:console';
import path from 'node:path';

const endpoint = Deno.env.get('ENDPOINT');
const clientName = Deno.env.get('NAME');

assert(endpoint != null, 'Server endpoint must be provided');
assert(clientName != null, 'client name must be provided');

// deno-lint-ignore no-explicit-any
async function toBuffer(log: Buffer, ...texts: any[]): Promise<void> {
  for (const i in texts) {
    await log.write(new TextEncoder().encode(texts[i]));
  }
}

// deno-lint-ignore no-explicit-any
async function toBufferLine(log: Buffer, ...texts: any[]): Promise<void> {
  const lineItems = texts.map((item, index) => {
    let lineItem = typeof item === 'string' ? item : Deno.inspect(item);

    if (index < texts.length - 1) {
      lineItem += ' ';
    }

    return lineItem;
  });

  return await toBuffer(log, ...lineItems, '\n');
}

const baseDir = path.resolve(`./debug/${clientName}/`);
Deno.mkdirSync(baseDir, { recursive: true });

const timer = Date.now();

Deno.serve({ port: 8000 }, async (request) => {
  const log = new Buffer();
  const start = Date.now();

  const { pathname, search } = new URL(request.url);
  // Element X has this weird double slash for this request
  // and it messes up URL constructor
  const url = new URL(pathname.replace(/^\/+/, '/'), endpoint);
  url.search = search;

  const startingPoint = start - timer;
  const filename = `${sprintf('%08d', startingPoint)}_${request.method}_${
    pathname.replace(/\//g, '__')
  }.md`;

  await toBufferLine(log, '\n##', request.method, pathname);

  if (search.length > 0) {
    await toBufferLine(log, '>', '`' + search + '`');
  }

  await toBufferLine(log, '\n````json');
  await toBufferLine(
    log,
    `+ ${format(start - timer, { ignoreZero: true })}`,
  );
  await toBufferLine(log, '===');
  await toBufferLine(log, '>', request.method, pathname, search);
  await toBufferLine(log, request.headers);

  const headers = new Headers(request.headers);
  headers.set('host', url.hostname);
  if (headers.get('accept-encoding')?.match(/\bbr\b/)) {
    headers.set('accept-encoding', 'gzip, deflate');
  }

  let requestBody = request.body;

  if (requestBody != null) {
    await toBufferLine(log, '---');
    const requestBodyLogger = new TransformStream({
      transform: async (chunk, controller) => {
        await toBuffer(log, new TextDecoder().decode(chunk));
        controller.enqueue(chunk);
      },
    });

    requestBody.pipeTo(requestBodyLogger.writable);
    requestBody = requestBodyLogger.readable;
  }

  const out_response = await fetch(url, {
    method: request.method,
    headers,
    body: requestBody,
    redirect: 'manual',
  });

  const responseBody = out_response.body;

  await toBufferLine(log, '\n***');
  await toBufferLine(log, '\n<', out_response.status);
  await toBufferLine(log, out_response.headers);
  await toBufferLine(log, '---');

  let consumer = responseBody;

  const responseMediaType = out_response.headers.get('content-type');
  const [responseContentType, responseContentSubtype] =
    responseMediaType?.split('/', 2) ?? ['', ''];

  if (
    responseContentType === 'text' ||
    (responseContentType === 'application' && responseContentSubtype === 'json')
  ) {
    const logger = new TransformStream({
      transform: async (chunk, controller) => {
        await toBuffer(log, new TextDecoder().decode(chunk));
        controller.enqueue(chunk);
      },
      flush: async (_controller) => {
        await toBufferLine(log, '\n===');
        await toBufferLine(
          log,
          `${format(Date.now() - start, { ignoreZero: true })}`,
        );
        await toBufferLine(log, '````');
        await toBufferLine(log, '\n');
        await Deno.writeFile(path.resolve(baseDir, filename), log.bytes());
        // report file op
        await Deno.stdout.write(new TextEncoder().encode(`+ ${filename}\n`));
        log.reset();
      },
    });

    if (responseBody != null) {
      const contentEncoding = out_response.headers.get('content-encoding');
      if (
        contentEncoding != null && ['deflate', 'gzip'].includes(contentEncoding)
      ) {
        const decompressStream = new DecompressionStream(
          contentEncoding as CompressionFormat,
        );
        responseBody.pipeThrough(decompressStream).pipeTo(logger.writable);
      } else {
        responseBody.pipeTo(logger.writable);
      }

      consumer = logger.readable;
    } else {
      consumer = responseBody;
    }
  } else {
    await toBufferLine(log, `[[Content-Type: ${responseMediaType}]]`);
    consumer = responseBody;
  }

  return new Response(consumer, {
    status: out_response.status,
    headers: out_response.headers,
  });
});
