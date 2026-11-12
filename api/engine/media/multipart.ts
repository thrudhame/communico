// A bounded two-part Matrix media envelope. Bytes remain unpublished until
// the *whole* envelope has closed; a malformed tail aborts the disk writer.
import { field, fieldText, mediaType } from '#engine/net/fields.ts';
import { decodeJson, objectOf } from '#engine/net/json.ts';
import { limit, protocol } from '#engine/net/upstream-error.ts';
const enc = new TextEncoder();
const HEADER_LIMIT = 16384;
const METADATA_LIMIT = 65536;
export const MEDIA_ENVELOPE_LIMIT = 2 * HEADER_LIMIT + METADATA_LIMIT + 1024;

function invalid(): never {
  protocol('media-multipart', 'invalid federation media envelope');
}
function indexOf(bytes: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
function headers(bytes: Uint8Array): Headers {
  const result = new Headers();
  if (bytes.length === 0) return result;
  // MIME permits continuation lines, unlike HTTP response heads. Decode the
  // field octets directly rather than interpreting them as UTF-8 text.
  const text = fieldText(bytes).replace(/\r\n[ \t]+/g, ' ');
  for (const line of text.split('\r\n')) {
    const [name, value] = field(line, 'media-multipart');
    if (
      result.has(name) &&
      [
        'content-type',
        'content-disposition',
        'content-transfer-encoding',
        'location',
      ].includes(name)
    ) invalid();
    result.append(name, value);
  }
  return result;
}
export type MediaPart = {
  contentType: string;
  disposition: string | null;
  location: string | null;
  size: number;
};

/** Wrap a completed local-media response without buffering or redirecting it. */
export function multipartResponse(media: Response): Response {
  if (!media.ok || media.body === null) {
    throw new Error('media response has no bytes');
  }
  const boundary = 'matrix_' + crypto.randomUUID().replaceAll('-', '');
  const type = media.headers.get('content-type') ?? 'application/octet-stream';
  const disposition = media.headers.get('content-disposition');
  const prefix = enc.encode(
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n{}\r\n--${boundary}\r\nContent-Type: ${type}\r\n${
      disposition === null ? '' : `Content-Disposition: ${disposition}\r\n`
    }\r\n`,
  );
  const suffix = enc.encode(`\r\n--${boundary}--\r\n`);
  const reader = media.body.getReader();
  let started = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(prefix);
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) {
          controller.enqueue(suffix);
          controller.close();
          reader.releaseLock();
        } else controller.enqueue(next.value);
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  const responseHeaders = new Headers({
    'Content-Type': `multipart/mixed; boundary=${boundary}`,
  });
  const length = media.headers.get('content-length');
  if (
    length !== null && /^\d+$/.test(length) &&
    Number.isSafeInteger(Number(length) + prefix.length + suffix.length)
  ) {
    responseHeaders.set(
      'Content-Length',
      String(Number(length) + prefix.length + suffix.length),
    );
  }
  return new Response(body, { headers: responseHeaders });
}

export function mediaMultipart(
  contentType: string,
  output: WritableStream<Uint8Array>,
  maxBytes: number,
): { stream: WritableStream<Uint8Array>; result: MediaPart } {
  const type = mediaType(contentType);
  const boundaries = type.parameters.get('boundary');
  if (
    type.value !== 'multipart/mixed' || boundaries?.length !== 1 ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 0
  ) invalid();
  const boundary = boundaries[0];
  if (
    !/^[0-9A-Za-z'()+_,.\/:=? -]{1,70}$/.test(boundary) ||
    boundary.endsWith(' ')
  ) invalid();
  const opening = enc.encode('--' + boundary);
  const delimiter = enc.encode('\r\n--' + boundary);
  const newline = enc.encode('\r\n');
  const headerEnd = enc.encode('\r\n\r\n');
  const writer = output.getWriter();
  const result: MediaPart = {
    contentType: 'application/octet-stream',
    disposition: null,
    location: null,
    size: 0,
  };
  let buffer: Uint8Array = new Uint8Array();
  let state: 'opening' | 'headers' | 'body' | 'end' = 'opening';
  let part = 0;
  let metadata: Uint8Array[] = [];
  let metadataBytes = 0;
  let envelopeBytes = 0;
  let failed = false;
  async function abort(error: unknown) {
    if (!failed) {
      failed = true;
      await writer.abort(error);
    }
  }
  function consume(n: number, envelope = true) {
    buffer = buffer.slice(n);
    if (envelope) {
      envelopeBytes += n;
      if (envelopeBytes > MEDIA_ENVELOPE_LIMIT) {
        limit('media-multipart', 'media envelope exceeds byte limit');
      }
    }
  }
  async function bytes(n: number) {
    if (part === 0) {
      metadataBytes += n;
      if (metadataBytes > METADATA_LIMIT) {
        limit('media-multipart', 'media metadata exceeds byte limit');
      }
      metadata.push(buffer.slice(0, n));
      consume(n);
    } else {
      result.size += n;
      if (result.size > maxBytes) {
        limit('media-multipart', 'media exceeds byte limit');
      }
      if (result.location !== null && n > 0) invalid();
      if (n) await writer.write(buffer.slice(0, n));
      consume(n, false);
    }
  }
  // A delimiter is a complete MIME line, not merely a matching byte prefix.
  // null means the suffix needs more bytes; false means payload lookalike.
  function boundaryLine(
    at: number,
    marker: Uint8Array,
    eof: boolean,
  ): { final: boolean; length: number } | null | false {
    let end = at + marker.length;
    if (end >= buffer.length) return eof ? false : null;
    let final = false;
    if (buffer[end] === 45) {
      if (end + 1 >= buffer.length) return eof ? false : null;
      if (buffer[end + 1] !== 45) return false;
      final = true;
      end += 2;
    }
    while (buffer[end] === 32 || buffer[end] === 9) {
      end++;
      if (end - at > HEADER_LIMIT) {
        limit('media-multipart', 'delimiter line exceeds byte limit');
      }
    }
    if (end === buffer.length) {
      return final && eof ? { final, length: end - at } : eof ? false : null;
    }
    if (buffer[end] !== 13) return false;
    if (end + 1 === buffer.length) return eof ? false : null;
    return buffer[end + 1] === 10 ? { final, length: end + 2 - at } : false;
  }
  async function drain(eof = false) {
    while (true) {
      if (state === 'opening') {
        if (indexOf(buffer, opening) === 0) {
          const line = boundaryLine(0, opening, eof);
          if (line === null) return;
          if (line !== false) {
            if (line.final) invalid();
            consume(line.length);
            state = 'headers';
            continue;
          }
        }
        const end = indexOf(buffer, newline);
        if (end < 0) {
          if (buffer.length + envelopeBytes > MEDIA_ENVELOPE_LIMIT) {
            limit('media-multipart', 'preamble exceeds byte limit');
          }
          return;
        }
        consume(end + 2);
      } else if (state === 'headers') {
        const empty = buffer[0] === 13 && buffer[1] === 10;
        const end = empty ? 0 : indexOf(buffer, headerEnd);
        if (end < 0) {
          if (buffer.length > HEADER_LIMIT) {
            limit('media-multipart', 'part headers exceed byte limit');
          }
          return;
        }
        if (end > HEADER_LIMIT) {
          limit('media-multipart', 'part headers exceed byte limit');
        }
        const h = headers(buffer.subarray(0, end));
        // HTTP carries binary octets already. Identity MIME encodings preserve
        // them; never cache base64/quoted-printable text as the original media.
        const cte = h.get('content-transfer-encoding')?.toLowerCase();
        if (cte !== undefined && !['binary', '8bit', '7bit'].includes(cte)) {
          protocol('media-multipart', 'unsupported content-transfer-encoding');
        }
        if (part === 0) {
          if (
            mediaType(h.get('content-type') ?? '').value !==
              'application/json' || h.has('location')
          ) invalid();
        } else {
          result.contentType = h.get('content-type') ??
            'application/octet-stream';
          mediaType(result.contentType);
          result.disposition = h.get('content-disposition');
          result.location = h.get('location');
          if (result.location === '') invalid();
        }
        consume(end + (empty ? 2 : 4));
        state = 'body';
      } else if (state === 'body') {
        let at = indexOf(buffer, delimiter);
        // Boundary-like payload bytes are legal unless the suffix is a delimiter.
        let line: ReturnType<typeof boundaryLine> = false;
        while (at >= 0) {
          line = boundaryLine(at, delimiter, eof);
          if (line === null) {
            if (at) await bytes(at);
            return;
          }
          if (line !== false) break;
          at = indexOf(buffer, delimiter, at + 1);
        }
        if (at < 0) {
          const ready = buffer.length - delimiter.length - 2;
          if (ready > 0) await bytes(ready);
          return;
        }
        await bytes(at);
        if (line === false || line === null) invalid();
        const final = line.final;
        consume(line.length);
        if (part === 0) {
          if (final) invalid();
          const joined = new Uint8Array(metadataBytes);
          let offset = 0;
          for (const chunk of metadata) {
            joined.set(chunk, offset);
            offset += chunk.length;
          }
          objectOf(decodeJson(joined, 'application/json'), 'media-metadata');
          metadata = [];
          part = 1;
          state = 'headers';
        } else {
          if (!final) invalid();
          state = 'end';
        }
      } else {
        consume(buffer.length); // RFC2046 epilogue is ignored, but still bounded.
        return;
      }
    }
  }
  const stream = new WritableStream<Uint8Array>({
    async write(chunk) {
      try {
        // Bound even a caller's giant write instead of making a second object-sized buffer.
        for (let at = 0; at < chunk.length; at += 16384) {
          const slice = chunk.subarray(at, at + 16384);
          const next = new Uint8Array(buffer.length + slice.length);
          next.set(buffer);
          next.set(slice, buffer.length);
          buffer = next;
          await drain();
        }
      } catch (error) {
        await abort(error);
        throw error;
      }
    },
    async close() {
      try {
        await drain(true);
        if (state !== 'end') {
          invalid();
        }
        await writer.close();
      } catch (error) {
        await abort(error);
        throw error;
      }
    },
    abort,
  });
  return { stream, result };
}
