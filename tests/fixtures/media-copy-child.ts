// Faults at the home side of the authenticated link. Keep the real peer,
// worker, stores, and HTTP consumers. Log only route/cut observations.
import { canonicalJson } from '#engine/canonical.ts';
import { LinkError, MEDIA_COPY_CAPABILITY } from '#engine/facade/protocol.ts';
import { LINK_PREFIX, LinkClient } from '#engine/facade/transport.ts';

const control = Deno.env.get('COMMUNICO_CONFIG') + '.media-copy';
const fetchLink = LinkClient.prototype.fetch;
const log = (event: string, offset = 0) =>
  Deno.writeTextFileSync(`${control}.trace`, `${event} ${offset}\n`, {
    append: true,
  });
const withoutCopy = (capabilities: typeof MEDIA_COPY_CAPABILITY[]) =>
  capabilities.filter(({ type }) => type !== MEDIA_COPY_CAPABILITY.type);

LinkClient.prototype.fetch = async function (path, init) {
  const route = path.slice(LINK_PREFIX.length);
  const phase = Deno.readTextFileSync(control);
  const media = path.startsWith(LINK_PREFIX + 'media-');
  const request = media ? JSON.parse(String(init?.body)) : {};
  if (media) log(`${phase}:${route}`, request.offset);
  if (phase === 'cut' && route === 'media-chunk' && request.offset > 0) {
    // The previous chunk is durable. Leave this exchange in flight until the
    // parent cuts home; the journal must progress while media is still held.
    const signal = init!.signal!;
    await new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else {signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });}
    });
  }
  if (route === 'media-applied' && phase === 'resume') {
    // Simulate loss of the request carrying the applied ACK, not of the file.
    throw new LinkError('LINK_UNAVAILABLE', 'lost applied ACK', 503);
  }
  if (route === 'media-applied' && phase === 'legacy-ack') {
    // Even a request on the authenticated link cannot ACK an unnegotiated type.
    const response = await fetchLink.call(this, path, {
      ...init,
      body: canonicalJson({
        ...request,
        required: withoutCopy(request.required),
      }),
    });
    const value = await response.clone().json();
    log(`legacy-ack:${response.status}:${value.code}`);
    return response;
  }
  const response = await fetchLink.call(this, path, init);
  if (!response.ok) return response;
  if (route === 'hello' && phase === 'legacy-peer') {
    const value = await response.json();
    log('legacy-peer:hello');
    return Response.json({ ...value, supported: withoutCopy(value.supported) });
  }
  if (route === 'media-manifests') {
    const value = await response.json();
    log(`${phase}:manifests`, value.manifests.length);
    if (request.after === '') {
      log(`${phase}:start`, value.manifests.length);
    }
    if (phase === 'manifest') {
      for (const item of value.manifests) item.filename = 'different.txt';
    }
    return Response.json(value);
  }
  if (
    route === 'media-chunk' &&
    ['order', 'digest', 'fingerprint'].includes(phase)
  ) {
    const value = await response.json();
    if (phase === 'order') value.chunk.offset++;
    if (phase === 'digest') value.chunk.sha256 = '0'.repeat(64);
    if (phase === 'fingerprint') value.chunk.fingerprint = '0'.repeat(64);
    return Response.json(value);
  }
  return response;
};

await import('./facade-child.ts');
