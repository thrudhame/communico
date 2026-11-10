// A bounded two-part Matrix media envelope. Bytes remain unpublished until
// the *whole* envelope has closed; a malformed tail aborts the disk writer.
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const HEADER_LIMIT = 16384;
const METADATA_LIMIT = 65536;
export const MEDIA_ENVELOPE_LIMIT = 2 * HEADER_LIMIT + METADATA_LIMIT + 1024;

function invalid(): never {
  throw new Error('invalid federation media envelope');
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
  for (const line of dec.decode(bytes).split('\r\n')) {
    const m = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n\0]*)$/.exec(line);
    if (!m || result.has(m[1])) invalid();
    result.set(m[1], m[2].trim());
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
  // RFC boundary alphabet, quoted or token; reject duplicate/unknown parameters.
  const match =
    /^multipart\/mixed\s*;\s*boundary=(?:"([0-9A-Za-z'()+_,.\/:=? -]{1,70})"|([0-9A-Za-z'()+_,.\/:=?-]{1,70}))\s*$/i
      .exec(contentType);
  if (!match || !Number.isSafeInteger(maxBytes) || maxBytes < 0) invalid();
  const boundary = match[1] ?? match[2];
  if (boundary.endsWith(' ')) invalid();
  const opening = enc.encode('--' + boundary + '\r\n');
  const delimiter = enc.encode('\r\n--' + boundary);
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
      if (envelopeBytes > MEDIA_ENVELOPE_LIMIT) invalid();
    }
  }
  async function bytes(n: number) {
    if (part === 0) {
      metadataBytes += n;
      if (metadataBytes > METADATA_LIMIT) invalid();
      metadata.push(buffer.slice(0, n));
      consume(n);
    } else {
      result.size += n;
      if (result.size > maxBytes || (result.location !== null && n > 0)) {
        invalid();
      }
      if (n) await writer.write(buffer.slice(0, n));
      consume(n, false);
    }
  }
  async function drain() {
    while (true) {
      if (state === 'opening') {
        if (buffer.length < opening.length) return;
        if (indexOf(buffer, opening) !== 0) invalid();
        consume(opening.length);
        state = 'headers';
      } else if (state === 'headers') {
        const end = indexOf(buffer, headerEnd);
        if (end < 0) {
          if (buffer.length > HEADER_LIMIT) invalid();
          return;
        }
        if (end > HEADER_LIMIT) invalid();
        const h = headers(buffer.subarray(0, end));
        if (part === 0) {
          if (
            !/^application\/json(?:\s*;|$)/i.test(
              h.get('content-type') ?? '',
            ) || h.has('location')
          ) invalid();
        } else {
          result.contentType = h.get('content-type') ??
            'application/octet-stream';
          result.disposition = h.get('content-disposition');
          result.location = h.get('location');
          if (result.location === '') invalid();
        }
        consume(end + 4);
        state = 'body';
      } else if (state === 'body') {
        let at = indexOf(buffer, delimiter);
        // Boundary-like payload bytes are legal unless the suffix is a delimiter.
        while (at >= 0) {
          if (buffer.length < at + delimiter.length + 2) {
            if (at) await bytes(at);
            return;
          }
          const a = buffer[at + delimiter.length],
            b = buffer[at + delimiter.length + 1];
          if ((a === 45 && b === 45) || (a === 13 && b === 10)) break;
          at = indexOf(buffer, delimiter, at + 1);
        }
        if (at < 0) {
          const ready = buffer.length - delimiter.length - 2;
          if (ready > 0) await bytes(ready);
          return;
        }
        await bytes(at);
        const final = buffer[delimiter.length] === 45;
        consume(delimiter.length + 2);
        if (part === 0) {
          if (final) invalid();
          const joined = new Uint8Array(metadataBytes);
          let offset = 0;
          for (const chunk of metadata) {
            joined.set(chunk, offset);
            offset += chunk.length;
          }
          const value = JSON.parse(dec.decode(joined));
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            invalid();
          }
          metadata = [];
          part = 1;
          state = 'headers';
        } else {
          if (!final) invalid();
          state = 'end';
        }
      } else {
        if (
          buffer.length > 2 || (buffer.length > 0 && buffer[0] !== 13) ||
          (buffer.length > 1 && buffer[1] !== 10)
        ) invalid();
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
        await drain();
        if (state !== 'end' || (buffer.length !== 0 && buffer.length !== 2)) {
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
