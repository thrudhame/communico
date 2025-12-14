Deno.serve({ port: 8080 }, async (request) => {
  const { pathname, search } = new URL(request.url);
  const url = new URL(pathname, Deno.env.get('ENDPOINT'));
  url.search = search;

  const headers = new Headers(request.headers);
  headers.set('Host', url.hostname);
  headers.set('Accept-Encoding', 'gzip, deflate');

  console.log('\n----------------------------------');
  console.log('>', request.method, pathname);
  console.log(headers);

  const out_response = await fetch(url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual',
  });

  let responseBody = out_response.body;

  console.log('<', out_response.status);
  console.log(out_response.headers);
  console.log('---');

  if (responseBody != null) {
    const [toRepond, toLog] = responseBody.tee();
    responseBody = toRepond;

    const contentEncoding = out_response.headers.get('content-encoding');
    if (contentEncoding === 'deflate' || contentEncoding === 'gzip') {
      const decompressStream = new DecompressionStream(
        contentEncoding as CompressionFormat,
      );
      toLog.pipeThrough(decompressStream).pipeTo(Deno.stdout.writable);
    } else {
      toLog.pipeTo(Deno.stdout.writable);
    }
  }

  return new Response(responseBody, {
    status: out_response.status,
    headers: out_response.headers,
  });
});
