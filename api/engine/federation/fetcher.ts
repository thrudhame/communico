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
import type { Pdu } from '#engine/pdu.ts';
import { type Fetcher, SendJoinRefused } from '#engine/room/deps.ts';
import type { Signer } from '#engine/room/signer.ts';
import type { Database as Db } from '#engine/store/db.ts';
import { FederationHttpError, federationRequest } from './client.ts';

function jsonObject(res: { json: unknown }): Record<string, unknown> {
  return res.json !== null && typeof res.json === 'object' &&
      !Array.isArray(res.json)
    ? res.json as Record<string, unknown>
    : {};
}

function pdusOf(obj: Record<string, unknown>, key: string): Pdu[] {
  const list = obj[key];
  return Array.isArray(list) ? list as Pdu[] : [];
}

// v2 → v1 fallback ONLY on endpoint-unknown answers (joins-v2.yaml:26-32):
// 404/405 with M_UNRECOGNIZED or a non-Matrix body; a genuine remote
// 400/403 with a Matrix body is the answer and is surfaced, not replayed
function isEndpointUnknown(e: unknown): boolean {
  if (!(e instanceof FederationHttpError)) return false;
  if (e.remoteStatus !== 404 && e.remoteStatus !== 405) return false;
  return !e.matrixBody || e.errcode === 'M_UNRECOGNIZED';
}

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

export function productionFetcher(server: Db, signer: Signer): Fetcher {
  const bulk = () => config().federation.bulkmaxbytes;
  return {
    // GET /_matrix/federation/v1/event/{eventId} — the PDU, or null on
    // 404/unreachable.
    event: async (id, via) => {
      try {
        const res = await federationRequest(server, signer, {
          destination: via,
          method: 'GET',
          path: `/_matrix/federation/v1/event/${encodeURIComponent(id)}`,
          body: null,
        });
        const pdus = pdusOf(jsonObject(res), 'pdus');
        return pdus.length === 0 ? null : pdus[0];
      } catch {
        return null; // a 404 on the id — the caller decides what it means
      }
    },

    // POST /_matrix/federation/v1/get_missing_events/{roomId}.
    missingEvents: async (roomId, earliest, latest, limit, via) => {
      const res = await federationRequest(server, signer, {
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
      return pdusOf(jsonObject(res), 'events');
    },

    // GET /_matrix/federation/v1/state_ids/{roomId}?event_id=at.
    stateIds: async (roomId, at, via) => {
      try {
        const res = await federationRequest(server, signer, {
          destination: via,
          method: 'GET',
          path: `/_matrix/federation/v1/state_ids/${
            encodeURIComponent(roomId)
          }?event_id=${encodeURIComponent(at)}`,
          body: null,
        });
        const j = jsonObject(res);
        return {
          pduIds: pdusOf(j, 'pdu_ids').map((p) => String(p)),
          authChainIds: pdusOf(j, 'auth_chain_ids').map((p) => String(p)),
        };
      } catch {
        return null; // the prev stays missing — the caller's terminal decides
      }
    },

    // GET /_matrix/federation/v1/event_auth/{roomId}/{eventId}.
    eventAuth: async (roomId, id, via) => {
      try {
        const res = await federationRequest(server, signer, {
          destination: via,
          method: 'GET',
          path: `/_matrix/federation/v1/event_auth/${
            encodeURIComponent(roomId)
          }/${encodeURIComponent(id)}`,
          body: null,
          maxBytes: bulk(),
        });
        const j = jsonObject(res);
        const chain = j.auth_chain;
        return Array.isArray(chain) ? chain as Pdu[] : null;
      } catch {
        return null;
      }
    },

    // GET /_matrix/federation/v1/backfill/{roomId}?v=…&limit=.
    backfill: async (roomId, from, limit, via) => {
      const res = await federationRequest(server, signer, {
        destination: via,
        method: 'GET',
        path: `/_matrix/federation/v1/backfill/${encodeURIComponent(roomId)}?${
          from.map((v) => `v=${encodeURIComponent(v)}`).join('&')
        }&limit=${limit}`,
        body: null,
        maxBytes: bulk(),
      });
      return pdusOf(jsonObject(res), 'pdus');
    },

    // GET /_matrix/federation/v1/make_join/{roomId}/{userId}?ver=…
    makeJoin: async (roomId, userId, versions, via) => {
      const res = await federationRequest(server, signer, {
        destination: via,
        method: 'GET',
        path: `/_matrix/federation/v1/make_join/${encodeURIComponent(roomId)}/${
          encodeURIComponent(userId)
        }?ver=${versions.map(encodeURIComponent).join('&ver=')}`,
        body: null,
      });
      const j = jsonObject(res);
      // the spec's wrapper (joins-v1.yaml:55-81): room_version + event;
      // an absent version is the pre-v1 default
      const version = j.room_version;
      return {
        roomVersion: version === undefined || version === null
          ? '11'
          : String(version),
        event:
          (j.event !== undefined && j.event !== null ? j.event : {}) as Pdu,
      };
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
      const unwrap = (j: Record<string, unknown>) => ({
        state: pdusOf(j, 'state'),
        authChain: pdusOf(j, 'auth_chain'),
        event: j.event !== undefined && j.event !== null
          ? j.event as Pdu
          : undefined,
      });
      try {
        const res = await federationRequest(server, signer, {
          destination: via,
          method: 'PUT',
          path: `/_matrix/federation/v2/send_join/${
            encodeURIComponent(roomId)
          }/${encodeURIComponent(eventId)}`,
          body,
          maxBytes: bulk(),
        });
        return unwrap(jsonObject(res));
      } catch (e) {
        if (!isEndpointUnknown(e)) sendJoinFailure(e);
        let res;
        try {
          res = await federationRequest(server, signer, {
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
        // the v1 wrapper: [statusCode, body]
        const arr = Array.isArray(res.json) ? res.json : [];
        const inner = arr.length > 1 && arr[1] !== null &&
            typeof arr[1] === 'object' && !Array.isArray(arr[1])
          ? arr[1] as Record<string, unknown>
          : {};
        return unwrap(inner);
      }
    },
  };
}
