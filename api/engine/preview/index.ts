import { theApp } from '#engine/app.ts';
import { localpartOf } from '#engine/ids.ts';
import { config, serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { mediaMaxBytes, newMediaId, storeUploadBody } from '#engine/media.ts';
import { createMedia } from '#engine/tenant/media.ts';
import { imageDimensions } from './dimensions.ts';
import { guardedGet } from './guard.ts';
import { openGraphFor } from './og.ts';
import {
  recoverableUpstream,
  UpstreamError,
} from '#engine/net/upstream-error.ts';

export { cidrContains, parseCidr, parseIp } from './cidr.ts';
export { imageDimensions } from './dimensions.ts';
export { guardedGet } from './guard.ts';
export { decodeHtmlBody, openGraphFor, parseOpenGraph } from './og.ts';

function filenameOf(url: string): string {
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    return '';
  }
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

export async function previewUrl(
  userId: string,
  url: string,
  acceptLanguage: string | null,
): Promise<Record<string, string | number>> {
  const cfg = config().preview;
  if (!cfg.enabled) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'URL previews are disabled on this server',
    );
  }
  // Client input errors are public errors, separate from remote redirect grammar.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'invalid url');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'url scheme must be http or https',
    );
  }
  let page;
  try {
    page = await guardedGet(url, {
      maxBytes: cfg.maxbytes,
      blocklist: cfg.blocklist,
      allowlist: cfg.allowlist,
      acceptLanguage,
    });
  } catch (error) {
    if (
      error instanceof UpstreamError && error.context.phase === 'preview-policy'
    ) throw new MatrixError(403, 'M_FORBIDDEN', error.context.reason);
    throw error;
  }
  const mime = page.contentType.split(';')[0].trim().toLowerCase();
  const og: Record<string, string | number> = openGraphFor(
    page.body,
    page.contentType,
    page.url,
  );
  const imageUrl = og['og:image'];
  if (typeof imageUrl !== 'string' || mime.startsWith('image/')) return og;
  let absolute: string;
  try {
    absolute = new URL(imageUrl, page.url).href;
  } catch {
    delete og['og:image'];
    return og;
  }
  const mediaCap = mediaMaxBytes();
  const imageCap = cfg.maxbytes < mediaCap ? cfg.maxbytes : mediaCap;
  let img;
  try {
    img = await guardedGet(absolute, {
      maxBytes: imageCap,
      blocklist: cfg.blocklist,
      allowlist: cfg.allowlist,
      acceptLanguage,
    });
  } catch (error) {
    if (!recoverableUpstream(error)) throw error;
    delete og['og:image'];
    return og;
  }
  const mediaId = newMediaId();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(img.body);
      controller.close();
    },
  });
  const sizeBytes = await storeUploadBody(stream, mediaId);
  const filename = filenameOf(absolute);
  const contentType = img.contentType.split(';')[0].trim();
  await createMedia(theApp().tenant, localpartOf(userId), mediaId, 'uploaded', {
    content_type: contentType,
    filename: filename.length > 0 ? filename : undefined,
    size_bytes: sizeBytes,
  });
  og['og:image'] = 'mxc://' + serverName() + '/' + mediaId;
  og['og:image:type'] = contentType;
  og['matrix:image:size'] = sizeBytes;
  const dim = imageDimensions(img.body);
  if (dim !== null) {
    og['og:image:width'] = dim.width;
    og['og:image:height'] = dim.height;
  }
  return og;
}
