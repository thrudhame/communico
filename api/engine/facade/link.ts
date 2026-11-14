// Home initiates every exchange. The network adapter delegates enrollment and
// signatures to their owner, never reads registry tables or provisions a tenant.
import { canonicalJson } from '#engine/canonical.ts';
import type { Pairings } from './pairing.ts';
import {
  LINK_CAPABILITIES,
  LINK_VERSION,
  LinkError,
  negotiate,
  object,
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
