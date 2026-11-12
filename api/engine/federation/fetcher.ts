// api/engine/federation/fetcher.ts — the production Fetcher (3c's
// injected interface) over the signed client: event, missing events,
// state_ids, event_auth, backfill, make_join, send_join. Every answer is
// untrusted input — the room core passes it through the one verification
// path before anything is stored. Wire shapes from doltgres (paths,
// bodies, response unwraps); the caps: single-document answers ride
// federation.maxbytes, PDU-carrying answers federation.bulkmaxbytes (the
// old code used maxbytes for everything — the leaf existed for exactly
// these but was never wired). Null-vs-throw follows the 3c consumers:
// event/stateIds/eventAuth answer null (the caller's chase decides),
// missingEvents/backfill/makeJoin/sendJoin throw (the caller catches
// into its ladder/failover).
import { config } from '#engine/config.ts';
import { type Fetcher, SendJoinRefused } from '#engine/room/deps.ts';
import type { Signer } from '#engine/room/signer.ts';
import type { Database as Db } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import { recoverableUpstream } from '#engine/net/upstream-error.ts';
import { objectOf } from '#engine/net/json.ts';
import {
  eventResponse,
  membershipTemplate,
  pduList,
  sendJoinResponse,
  stateIdsResponse,
  stateResponse,
  timestampResponse,
  transactionPdus,
} from './responses.ts';
import {
  FederationHttpError,
  federationRequest,
  isEndpointUnknown,
} from './client.ts';

function sendJoinFailure(error: unknown): never {
  if (
    error instanceof FederationHttpError && error.matrixBody &&
    error.remoteStatus >= 400 && error.remoteStatus < 500 &&
    error.remoteStatus !== 408 && error.remoteStatus !== 429
  ) {
    throw new SendJoinRefused(
      error.status,
      error.errcode,
      String(error.responseBody().error),
    );
  }
  throw error;
}

export function productionFetcher(
  server: Db,
  signer: Signer,
  store: Store,
): Fetcher {
  const bulk = () => config().federation.bulkmaxbytes;
  return {
    // GET /_matrix/federation/v1/event/{eventId} — the PDU, or null on
    // 404/unreachable.
    event: async (id, via, roomId, signal) => {
      try {
        const res = await federationRequest(server, signer, {
          room: { store, id: roomId },
          destination: via,
          method: 'GET',
          path: `/_matrix/federation/v1/event/${encodeURIComponent(id)}`,
          body: null,
          signal,
        });
        return eventResponse(res.json);
      } catch (error) {
        if (recoverableUpstream(error, signal)) return null;
        throw error;
      }
    },

    timestampToEvent: async (roomId, ts, dir, via, signal) => {
      try {
        const res = await federationRequest(server, signer, {
          room: { store, id: roomId },
          destination: via,
          method: 'GET',
          path: `/_matrix/federation/v1/timestamp_to_event/${
            encodeURIComponent(roomId)
          }?ts=${ts}&dir=${dir}`,
          body: null,
          signal,
        });
        return timestampResponse(res.json);
      } catch (error) {
        if (recoverableUpstream(error, signal)) return null;
        throw error;
      }
    },

    // POST /_matrix/federation/v1/get_missing_events/{roomId}.
    missingEvents: async (roomId, earliest, latest, limit, via) => {
      const res = await federationRequest(server, signer, {
        room: { store, id: roomId },
        destination: via,
        method: 'POST',
        path: `/_matrix/federation/v1/get_missing_events/${
          encodeURIComponent(roomId)
        }`,
        body: new TextEncoder().encode(
          JSON.stringify({
            earliest_events: earliest,
            latest_events: latest,
            limit,
            min_depth: 0,
          }),
        ),
        maxBytes: bulk(),
      });
      return pduList(
        objectOf(res.json, 'missing-events').events,
        'missing-events',
      );
    },

    // GET /_matrix/federation/v1/state_ids/{roomId}?event_id=at.
    stateIds: async (roomId, at, via, signal) => {
      try {
        const res = await federationRequest(server, signer, {
          room: { store, id: roomId },
          destination: via,
          method: 'GET',
          path: `/_matrix/federation/v1/state_ids/${
            encodeURIComponent(roomId)
          }?event_id=${encodeURIComponent(at)}`,
          body: null,
          signal,
        });
        return stateIdsResponse(res.json);
      } catch (error) {
        if (recoverableUpstream(error, signal)) return null;
        throw error;
      }
    },

    state: async (roomId, at, via, signal) => {
      try {
        const res = await federationRequest(server, signer, {
          room: { store, id: roomId },
          destination: via,
          method: 'GET',
          path: `/_matrix/federation/v1/state/${
            encodeURIComponent(roomId)
          }?event_id=${encodeURIComponent(at)}`,
          body: null,
          signal,
          maxBytes: bulk(),
        });
        return stateResponse(res.json);
      } catch (error) {
        if (recoverableUpstream(error, signal)) return null;
        throw error;
      }
    },

    // GET /_matrix/federation/v1/event_auth/{roomId}/{eventId}.
    eventAuth: async (roomId, id, via) => {
      try {
        const res = await federationRequest(server, signer, {
          room: { store, id: roomId },
          destination: via,
          method: 'GET',
          path: `/_matrix/federation/v1/event_auth/${
            encodeURIComponent(roomId)
          }/${encodeURIComponent(id)}`,
          body: null,
          maxBytes: bulk(),
        });
        return pduList(
          objectOf(res.json, 'event-auth').auth_chain,
          'event-auth',
        );
      } catch (error) {
        if (recoverableUpstream(error)) return null;
        throw error;
      }
    },

    // GET /_matrix/federation/v1/backfill/{roomId}?v=…&limit=.
    backfill: async (roomId, from, limit, via, signal) => {
      const res = await federationRequest(server, signer, {
        room: { store, id: roomId },
        destination: via,
        method: 'GET',
        path: `/_matrix/federation/v1/backfill/${encodeURIComponent(roomId)}?${
          from.map((v) => `v=${encodeURIComponent(v)}`).join('&')
        }&limit=${limit}`,
        body: null,
        maxBytes: bulk(),
        signal,
      });
      return transactionPdus(res.json, 'backfill');
    },

    // GET /_matrix/federation/v1/make_join/{roomId}/{userId}?ver=…
    makeJoin: async (roomId, userId, versions, via) => {
      const res = await federationRequest(server, signer, {
        room: { store, id: roomId, participation: true },
        destination: via,
        method: 'GET',
        path: `/_matrix/federation/v1/make_join/${encodeURIComponent(roomId)}/${
          encodeURIComponent(userId)
        }?ver=${versions.map(encodeURIComponent).join('&ver=')}`,
        body: null,
      });
      return membershipTemplate(res.json, 'make-join', versions);
    },

    // PUT /_matrix/federation/v2/send_join/{roomId}/{eventId}; v1 only
    // on endpoint-unknown. `event` arrives WITH its computed id — the
    // wire form strips it (and unsigned) and carries it on the path.
    sendJoin: async (roomId, event, via) => {
      const wire = { ...(event as unknown as Record<string, unknown>) };
      const eventId = String(wire.event_id);
      delete wire.event_id;
      delete wire.unsigned;
      const body = new TextEncoder().encode(JSON.stringify(wire));
      try {
        const res = await federationRequest(server, signer, {
          room: { store, id: roomId, participation: true },
          destination: via,
          method: 'PUT',
          path: `/_matrix/federation/v2/send_join/${
            encodeURIComponent(roomId)
          }/${encodeURIComponent(eventId)}`,
          body,
          maxBytes: bulk(),
        });
        return sendJoinResponse(res.json);
      } catch (e) {
        if (!isEndpointUnknown(e)) sendJoinFailure(e);
        let res;
        try {
          res = await federationRequest(server, signer, {
            room: { store, id: roomId, participation: true },
            destination: via,
            method: 'PUT',
            path: `/_matrix/federation/v1/send_join/${
              encodeURIComponent(roomId)
            }/${encodeURIComponent(eventId)}`,
            body,
            maxBytes: bulk(),
          });
        } catch (error) {
          sendJoinFailure(error);
        }
        return sendJoinResponse(res.json, true);
      }
    },
  };
}
