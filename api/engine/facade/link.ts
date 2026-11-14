// Home initiates every exchange. The network adapter delegates enrollment and
// signatures to their owner, never reads registry tables or provisions a tenant.
import { canonicalJson } from '#engine/canonical.ts';
import type { Pairings } from './pairing.ts';
import type { Journal, PageLimits } from './journal.ts';
import { NoticeHub } from './notices.ts';
import {
  cutOf,
  integer,
  LINK_CAPABILITIES,
  LINK_VERSION,
  LinkError,
  negotiate,
  object,
  recordOf,
  type Stream,
  streamOf,
  text,
} from './protocol.ts';
import { LINK_PREFIX, LinkClient, type LinkTls } from './transport.ts';

async function message(request: Request): Promise<Record<string, unknown>> {
  try {
    return object(await request.json());
  } catch (error) {
    if (error instanceof LinkError) throw error;
    throw new LinkError('LINK_BAD_RECORD', 'invalid link JSON', 400);
  }
}

export function enrollmentHandler(options: {
  server: string;
  node: string;
  incarnation: string;
  pairings(): Promise<Pairings>;
  changed?(): Promise<void>;
}): (request: Request, peerPin: string) => Promise<Response> {
  return async (request, pin) => {
    const route = new URL(request.url).pathname;
    if (
      request.method !== 'POST' ||
      !['enroll', 'complete', 'revoke'].some((name) =>
        route === LINK_PREFIX + name
      )
    ) {
      return new Response(null, { status: 404 });
    }
    const body = await message(request);
    negotiate(body, options.server, LINK_CAPABILITIES);
    const id = text(body.pairing);
    // Enrollment's channel incarnation is the durable one-time pairing ID. The
    // separate journal stream incarnation is carried by each negotiated record.
    if (body.source !== 'home' || body.incarnation !== id) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'wrong enrollment source',
        403,
      );
    }
    const pairings = await options.pairings();
    let value: Record<string, unknown>;
    if (route === LINK_PREFIX + 'enroll') {
      value = {
        transcript: await pairings.challenge(id, text(body.secret), pin),
      };
    } else if (route === LINK_PREFIX + 'complete') {
      value = { receipt: await pairings.complete(id, body.grant, pin) };
      await options.changed?.();
    } else {
      // The pairing in the envelope and signed revocation must agree too.
      if (object(object(body.revocation).body).pairing !== id) {
        throw new LinkError(
          'LINK_IDENTITY_MISMATCH',
          'wrong revocation pairing',
          403,
        );
      }
      await pairings.retire(body.revocation, pin);
      await options.changed?.();
      value = { retired: true };
    }
    return Response.json({
      protocol: LINK_VERSION,
      server: options.server,
      required: LINK_CAPABILITIES,
      source: options.node,
      incarnation: options.incarnation,
      pairing: id,
      ...value,
    });
  };
}

/** The only plaintext credential input is the operator's protected bundle. Once
 * a grant exists, a restart or lost completion response retries that exact grant
 * without asking for the secret or inventing a new facade signing identity. */
export async function enrollLink(
  pairings: Pairings,
  id: string,
  tls: LinkTls,
  secret?: string,
  signal?: AbortSignal,
): Promise<void> {
  const peer = await pairings.connection(id);
  const context = peer.context;
  const client = new LinkClient(tls, {
    url: context.url,
    pin: context.facadePin,
  });
  async function call(route: string, fields: Record<string, unknown>) {
    const response = await client.fetch(LINK_PREFIX + route, {
      method: 'POST',
      signal,
      body: canonicalJson({
        protocol: LINK_VERSION,
        server: context.server,
        required: context.required,
        source: 'home',
        incarnation: id,
        pairing: id,
        ...fields,
      }),
      headers: { 'content-type': 'application/json' },
    });
    let body: Record<string, unknown>;
    try {
      body = object(await response.json());
    } catch {
      throw new LinkError('LINK_BAD_RECORD', 'invalid link response', 400);
    }
    if (!response.ok) {
      throw new LinkError(
        typeof body.code === 'string' ? body.code : 'LINK_UNAVAILABLE',
        'link exchange refused',
        response.status,
      );
    }
    negotiate(body, context.server, LINK_CAPABILITIES);
    if (body.source !== context.node || body.pairing !== id) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'wrong enrollment response source',
        403,
      );
    }
    return body;
  }
  if (peer.state === 'revoked') {
    const response = await call('revoke', {
      revocation: await pairings.revoke(id),
    });
    if (response.retired !== true) {
      throw new LinkError('LINK_DIVERGED', 'revocation not confirmed');
    }
    return;
  }
  let grant = peer.grant;
  if (!grant && peer.transcript) {
    grant = await pairings.grant(id, peer.transcript);
  }
  if (!grant) {
    if (!secret) {
      throw new LinkError(
        'LINK_UNPAIRED',
        'pending enrollment requires its protected bundle',
        503,
      );
    }
    const response = await call('enroll', { secret });
    if (
      response.incarnation !==
        object(object(response.transcript).body).incarnation
    ) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'wrong facade incarnation',
        403,
      );
    }
    grant = await pairings.grant(id, response.transcript);
  }
  const response = await call('complete', { grant });
  if (response.incarnation !== grant.body.transcript.body.incarnation) {
    throw new LinkError(
      'LINK_IDENTITY_MISMATCH',
      'wrong facade incarnation',
      403,
    );
  }
  await pairings.confirm(id, response.receipt);
}

export function linkHandler(options: {
  server: string;
  node: string;
  incarnation: string;
  pairings(): Promise<Pairings>;
  journal: Journal;
  limits: PageLimits;
  notices?: NoticeHub;
  changed?(): Promise<void>;
  contacted?(): Promise<void>;
}): (request: Request, peerPin: string) => Promise<Response> {
  const enroll = enrollmentHandler(options);
  const json = (raw: string | null) => {
    try {
      return JSON.parse(raw ?? '');
    } catch {
      throw new LinkError(
        'LINK_BAD_RECORD',
        'invalid link query or envelope',
        400,
      );
    }
  };
  return async (request, pin) => {
    const url = new URL(request.url);
    const route = url.pathname.slice(LINK_PREFIX.length);
    if (['enroll', 'complete', 'revoke'].includes(route)) {
      return await enroll(request, pin);
    }
    if (
      !((request.method === 'GET' &&
        ['hello', 'records', 'notices'].includes(route)) ||
        (request.method === 'POST' && ['records', 'ack'].includes(route)))
    ) {
      return new Response(null, { status: 404 });
    }
    const body = request.method === 'GET'
      ? object(json(request.headers.get('x-communico-link')))
      : await message(request);
    negotiate(body, options.server, LINK_CAPABILITIES);
    const id = text(body.pairing);
    if (body.source !== 'home' || body.incarnation !== id) {
      throw new LinkError('LINK_IDENTITY_MISMATCH', 'wrong link source', 403);
    }
    const grant = await (await options.pairings()).authorizedHome(id, pin);
    if (
      grant.body.transcript.body.context.node !== options.node ||
      grant.body.transcript.body.incarnation !== options.incarnation
    ) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'listener does not match enrolled node',
        403,
      );
    }
    await options.contacted?.();
    const response = (value: Record<string, unknown>) =>
      Response.json({
        protocol: LINK_VERSION,
        server: options.server,
        required: LINK_CAPABILITIES,
        source: options.node,
        incarnation: options.incarnation,
        pairing: id,
        ...value,
      });
    const checkedStream = (
      raw: unknown,
      source: string,
      incarnation: string,
    ): Stream => {
      const stream = streamOf(raw);
      if (stream.source !== source || stream.incarnation !== incarnation) {
        throw new LinkError(
          'LINK_IDENTITY_MISMATCH',
          'wrong journal source or incarnation',
          403,
        );
      }
      return stream;
    };
    const journal = options.journal;
    // Retention spans enrollment lifetimes; the active wire view does not.
    const activeStreams = async (direction: 'in' | 'out') =>
      (await journal.streams('home', direction)).filter((stream) =>
        direction === 'in'
          ? stream.source === 'home' && stream.incarnation === id
          : stream.source === options.node &&
            stream.incarnation === options.incarnation
      );
    if (route === 'notices') {
      const read = async () => {
        await (await options.pairings()).authorizedHome(id, pin);
        const streams = [
          ...await activeStreams('out'),
          ...await activeStreams('in'),
        ];
        return {
          protocol: LINK_VERSION,
          server: options.server,
          required: LINK_CAPABILITIES,
          source: options.node,
          incarnation: options.incarnation,
          pairing: id,
          heads: streams.map((stream) => ({
            ...streamOf(stream),
            head: stream.received,
          })),
        };
      };
      const websocket =
        request.headers.get('upgrade')?.toLowerCase() === 'websocket';
      if (websocket || request.headers.get('accept') === 'text/event-stream') {
        if (!options.notices) {
          throw new LinkError('LINK_UNAVAILABLE', 'notices not composed', 503);
        }
        return options.notices.response(read, request.signal, websocket);
      }
      return Response.json(await read());
    }
    if (route === 'hello') {
      const outgoing = await activeStreams('out');
      return response({
        revision: grant.body.revision,
        scopes: [],
        outgoing,
        incoming: await activeStreams('in'),
        exportAcks: await Promise.all(outgoing.map(async (stream) => ({
          ...streamOf(stream),
          ...await journal.acknowledged('home', stream),
        }))),
      });
    }
    if (request.method === 'GET') {
      const stream = checkedStream(
        json(url.searchParams.get('stream')),
        options.node,
        options.incarnation,
      );
      const after = integer(Number(text(url.searchParams.get('after'))));
      return response({
        page: await journal.page('home', 'out', stream, after, options.limits),
      });
    }
    if (route === 'ack') {
      const stream = checkedStream(
        body.stream,
        options.node,
        options.incarnation,
      );
      if (!Array.isArray(body.results)) {
        throw new LinkError(
          'LINK_BAD_RECORD',
          'terminal results must be an array',
          400,
        );
      }
      return response({
        ack: await journal.ack(
          'home',
          stream,
          cutOf(body.received),
          cutOf(body.applied),
          body.results,
        ),
      });
    }
    const stream = checkedStream(body.stream, 'home', id);
    if (!Array.isArray(body.records)) {
      throw new LinkError('LINK_BAD_RECORD', 'records must be an array', 400);
    }
    const records = body.records.map((raw) => {
      const record = recordOf(raw);
      const source = checkedStream(record, 'home', id);
      if (source.stream !== stream.stream) {
        throw new LinkError(
          'LINK_BAD_RECORD',
          'record belongs to another stream',
          400,
        );
      }
      return record;
    });
    const after = cutOf(body.after);
    // Validate the result cursor before any page receipt. A malformed request
    // must not partially advance received state and then fail while forming ACK.
    await journal.acknowledgement('home', stream, after, options.limits);
    await journal.receive('home', records);
    await options.changed?.();
    return response({
      ack: await journal.acknowledgement('home', stream, after, options.limits),
    });
  };
}
