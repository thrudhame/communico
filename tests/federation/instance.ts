// tests/federation/instance.ts — an in-process communico instance for
// the federation-loop tests: a real store (room+server+tenant), the
// production federation stack (client, KeyStore, resolver, fetcher,
// sender with the EDU queues, transactions, invites), and a loopback
// HTTPS listener routing the federation endpoints this stage provides —
// auth → transactions/invites, our key document, and the resident-side
// join/leave answers built on the room core (their stage-5 home is the
// endpoints layer; here they are test glue over the same functions).
// Two or three of these federate over loopback TLS (fixture CA) — no
// counterpart servers (plan §3).
import { config, setConfigForTests } from '#engine/config.ts';
import { eventIdFor } from '#engine/eventid.ts';
import { authenticateRequest } from '#engine/federation/auth.ts';
import {
  type EduQueues,
  eduQueues,
  type EduState,
  eduState,
} from '#engine/federation/edus.ts';
import { productionFetcher } from '#engine/federation/fetcher.ts';
import {
  acceptRescind,
  countersign,
  type InviteDeps,
  inviteIntentProvider,
  receiveInvite,
} from '#engine/federation/invites.ts';
import { keyDocResponse, notaryFromCache } from '#engine/federation/keydoc.ts';
import { keyStore, ourKeyDocument } from '#engine/federation/keys.ts';
import { productionKeyResolver } from '#engine/federation/keyresolver.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { makeKnock, sendKnock } from '#engine/federation/joins.ts';
import { type Sender, startSender } from '#engine/federation/sender.ts';
import { receiveTransaction } from '#engine/federation/transactions.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import { roomVersionOf } from '#engine/room/build.ts';
import type { RemoteDeps } from '#engine/room/deps.ts';
import { openRoom, type Room, roomSchema } from '#engine/room/index.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import type { Signer } from '#engine/room/signer.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import type { Database as Db } from '#engine/store/db.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { openTenant, type Tenant } from '#engine/tenant/index.ts';
import { domainOf, toWire } from '#engine/federation/pdu.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';

const FIXTURE = 'tests/fixtures/tls';

let installed = false;
function installOnce(): void {
  if (installed) return;
  installed = true;
  installServerHooks();
  setConfigForTests({
    federation: {
      cacerts: [`${FIXTURE}/ca.crt`],
      backoffstartmillihours: 1, // 3.6 s rungs — the old tests' pace
    },
  });
  resetCaCertsForTests();
}

export type ReceivedTxn = {
  txnId: string;
  origin: string;
  body: { pdus?: unknown[]; edus?: unknown[] };
};

export type Instance = {
  name: string; // localhost:PORT
  port: number;
  dir: string;
  store: Store;
  server: Db;
  tenant: Tenant;
  signer: Signer;
  edus: EduState;
  queues: EduQueues;
  sender: Sender;
  inviteDeps: InviteDeps;
  remoteDeps: () => RemoteDeps;
  receivedTxns: ReceivedTxn[];
  // restart the sender on the same store (the resume scan picks up
  // pending rows — the process-restart case)
  restartSender(): Promise<void>;
  stopNet(): Promise<void>;
  startNet(): Promise<void>;
  close(): Promise<void>;
};

function remoteDepsOf(
  server: Db,
  signer: Signer,
  self: string,
  store: Store,
): RemoteDeps {
  const fed = config().federation;
  return {
    keys: productionKeyResolver(server, signer),
    fetcher: productionFetcher(server, signer, store),
    self,
    limits: {
      waitMs: fed.missingwaitms,
      limit: fed.missinglimit,
      budgetMs: fed.missingbudgetms,
    },
    ungroundedMs: fed.ungroundedmillihours * 3_600,
  };
}

// The resident's make_join/make_leave template over the room core (old
// joins.ts's shape): live extremities, depth past them and the rulebook's
// selected auth events, including the join rule and subject's invitation.
async function membershipTemplate(
  room: Room,
  userId: string,
  membership: 'join' | 'leave',
): Promise<Record<string, unknown>> {
  return await room.tx(async (tx) => {
    const stay = await tx.segments.openStay();
    if (stay === null) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'not in the room');
    }
    const version = await roomVersionOf(tx, stay.id);
    const frontier = await tx.extremities.frontier(stay.id);
    let depth = 1;
    for (const id of frontier) {
      const row = await tx.events.get(id);
      if (row !== null) {
        depth = Math.max(depth, (JSON.parse(row.pdu) as Pdu).depth + 1);
      }
    }
    const group = await tx.state.current(stay.id);
    const auth = getRulebook(version).selectAuthEvents(
      {
        type: 'm.room.member',
        sender: userId,
        state_key: userId,
        content: { membership },
      } as unknown as Pdu,
      group === null ? new Map() : await tx.state.groupMap(group),
    );
    return {
      room_version: version,
      event: {
        type: 'm.room.member',
        state_key: userId,
        sender: userId,
        room_id: room.id,
        content: { membership },
        prev_events: frontier,
        auth_events: auth,
        depth,
        origin_server_ts: Date.now(),
      },
    };
  });
}

export async function startInstance(): Promise<Instance> {
  installOnce();
  const dir = await Deno.makeTempDir();
  const store = await openStore(
    {
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    },
    {
      schemas: { room: roomSchema, server: serverSchema, tenant: tenantSchema },
    },
  );
  const server = await store.server();

  // the listener first (the server name carries its port), the tenant
  // after — then everything that needs the name
  const receivedTxns: ReceivedTxn[] = [];
  const box = {
    tenant: null as Tenant | null,
    handler: null as
      | ((req: Request) => Promise<Response>)
      | null,
  };
  const cert = await Deno.readTextFile(`${FIXTURE}/localhost.crt`);
  const key = await Deno.readTextFile(`${FIXTURE}/localhost.key`);
  let http: Deno.HttpServer | null = null;
  const listen = (port: number) =>
    Deno.serve({ port, cert, key }, (req) => {
      if (box.handler === null) {
        return Promise.resolve(new Response('booting', { status: 503 }));
      }
      return box.handler(req);
    });
  http = listen(0);
  const port = (http.addr as Deno.NetAddr).port;
  const name = `localhost:${port}`;

  const tenant = await openTenant(store, name, { create: true });
  box.tenant = tenant;
  const signer = tenant.signer();
  const keys = keyStore(server, { signer });
  const edus = eduState(server, name, store);
  const box2 = { sender: null as Sender | null };
  const queues = eduQueues(
    (userId) => userId.endsWith(':' + name),
    (destination) => {
      if (box2.sender !== null) box2.sender.wake(destination);
    },
  );
  const sender = startSender({ store, signer, drainEdus: queues.drain });
  box2.sender = sender;
  const inviteDeps: InviteDeps = {
    store,
    server,
    signer,
    keys: productionKeyResolver(server, signer),
    self: name,
    wake: (destination) => sender.wake(destination),
  };
  sender.setIntentProvider(inviteIntentProvider(inviteDeps));

  const instance: Instance = {
    name,
    port,
    dir,
    store,
    server,
    tenant,
    signer,
    edus,
    queues,
    sender,
    inviteDeps,
    remoteDeps: () => remoteDepsOf(server, signer, name, store),
    receivedTxns,
    restartSender: async () => {
      await instance.sender.stop();
      const fresh = startSender({ store, signer, drainEdus: queues.drain });
      box2.sender = fresh;
      fresh.setIntentProvider(inviteIntentProvider(inviteDeps));
      instance.sender = fresh;
      inviteDeps.wake = (destination) => fresh.wake(destination);
    },
    stopNet: async () => {
      if (http !== null) {
        await http.shutdown();
        http = null;
      }
    },
    startNet: () => {
      if (http === null) http = listen(port);
      return Promise.resolve();
    },
    close: async () => {
      await instance.sender.stop();
      await instance.stopNet();
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };

  // --- the routing glue -------------------------------------------------

  async function authed(req: Request, body: Uint8Array): Promise<string> {
    const url = new URL(req.url);
    return await authenticateRequest(
      {
        server,
        keys,
        onContact: instance.sender.contactHook(),
      },
      name,
      {
        method: req.method,
        uri: url.pathname + url.search,
        authorization: req.headers.get('authorization'),
        body,
      },
    );
  }

  function errorOf(e: unknown): Response {
    if (e instanceof MatrixError) {
      return Response.json(e.responseBody(), { status: e.status });
    }
    return Response.json(
      { errcode: 'M_UNKNOWN', error: String(e) },
      { status: 500 },
    );
  }

  async function openParticipating(roomId: string): Promise<Room | null> {
    try {
      const room = await openRoom(store, roomId);
      const open = await room.tx(async (tx) =>
        (await tx.segments.openStay()) !== null
      );
      return open ? room : null;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
  }

  async function sendJoinAnswer(
    roomId: string,
    join: Pdu,
    origin: string,
  ): Promise<Response> {
    const room = await openParticipating(roomId);
    if (room === null) throw new MatrixError(404, 'M_NOT_FOUND', roomId);
    // the snapshot PRIOR to the join (joins-v2.yaml): the current state
    // and its auth closure, then the join ingested as a remote event
    const snapshot = await room.tx(async (tx) => {
      const stay = await tx.segments.openStay();
      const group = stay === null ? null : await tx.state.current(stay.id);
      const stateIds = group === null
        ? []
        : [...(await tx.state.groupMap(group)).values()];
      const authIds = [
        ...new Set((await tx.events.authClosure(stateIds, 1000)).ids),
      ];
      const stateRows = await tx.events.list(stateIds);
      const authRows = await tx.events.list(authIds);
      const version = stay === null ? '11' : await roomVersionOf(tx, stay.id);
      const pdusOf = (rows: Map<string, { pdu: string }>): Pdu[] =>
        [...rows.values()].map((r) => JSON.parse(r.pdu) as Pdu);
      return {
        state: pdusOf(stateRows),
        authChain: pdusOf(authRows),
        version,
      };
    });
    const outcomes = await ingestRemote(
      room,
      [join],
      origin,
      remoteDepsOf(server, signer, name, store),
    );
    const outcome = outcomes[0];
    if (outcome.outcome !== 'accepted' && outcome.outcome !== 'known') {
      throw new MatrixError(
        403,
        'M_FORBIDDEN',
        `join not accepted: ${outcome.outcome} ${outcome.error ?? ''}`,
      );
    }
    // our signature rides on the returned join (SS:881-885)
    await countersign(join, snapshot.version, signer);
    return Response.json({
      state: snapshot.state.map((p) => toWire(p, snapshot.version)),
      auth_chain: snapshot.authChain.map((p) => toWire(p, snapshot.version)),
      event: toWire(join, snapshot.version),
      members_omitted: false,
      servers_in_room: [name],
    });
  }

  box.handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const bodyBytes = req.method === 'GET'
      ? new Uint8Array()
      : new Uint8Array(await req.arrayBuffer());
    try {
      // unsigned endpoints
      if (path === '/_matrix/key/v2/server' && req.method === 'GET') {
        return keyDocResponse(await ourKeyDocument(signer, tenant.publicB64));
      }
      if (path.startsWith('/_matrix/key/v2/query/') && req.method === 'GET') {
        const forName = decodeURIComponent(
          path.slice('/_matrix/key/v2/query/'.length),
        );
        const doc = await notaryFromCache(server, signer, forName);
        return Response.json({ server_keys: doc === null ? [] : [doc] });
      }
      // everything below is authenticated
      const origin = await authed(req, bodyBytes);
      const bodyJson = bodyBytes.length === 0
        ? null
        : JSON.parse(new TextDecoder().decode(bodyBytes));
      const sendMatch = /^\/_matrix\/federation\/v1\/send\/(.+)$/.exec(path);
      if (sendMatch && req.method === 'PUT') {
        const txnId = decodeURIComponent(sendMatch[1]);
        receivedTxns.push({
          txnId,
          origin,
          body: bodyJson as ReceivedTxn['body'],
        });
        const res = await receiveTransaction(origin, txnId, bodyJson, {
          store,
          keys: productionKeyResolver(server, signer),
          fetcher: productionFetcher(server, signer, store),
          self: name,
          edus,
          rescind: (roomId, pdu) => acceptRescind(roomId, pdu, inviteDeps),
        });
        return Response.json(res.body, { status: res.status });
      }
      const inviteMatch =
        /^\/_matrix\/federation\/v2\/invite\/([^/]+)\/([^/]+)$/
          .exec(path);
      if (inviteMatch && req.method === 'PUT') {
        const res = await receiveInvite(
          decodeURIComponent(inviteMatch[1]),
          decodeURIComponent(inviteMatch[2]),
          bodyJson,
          origin,
          inviteDeps,
        );
        return Response.json(res);
      }
      const makeKnockMatch =
        /^\/_matrix\/federation\/v1\/make_knock\/([^/]+)\/([^/]+)$/.exec(path);
      if (makeKnockMatch && req.method === 'GET') {
        return Response.json(
          await makeKnock(
            decodeURIComponent(makeKnockMatch[1]),
            decodeURIComponent(makeKnockMatch[2]),
            origin,
            url.searchParams.getAll('ver'),
            inviteDeps,
          ),
        );
      }
      const sendKnockMatch =
        /^\/_matrix\/federation\/v1\/send_knock\/([^/]+)\/([^/]+)$/.exec(path);
      if (sendKnockMatch && req.method === 'PUT') {
        return Response.json(
          await sendKnock(
            decodeURIComponent(sendKnockMatch[1]),
            decodeURIComponent(sendKnockMatch[2]),
            bodyJson,
            origin,
            inviteDeps,
          ),
        );
      }
      const makeJoinRoute =
        /^\/_matrix\/federation\/v1\/make_join\/([^/]+)\/([^/]+)$/
          .exec(path);
      if (makeJoinRoute && req.method === 'GET') {
        const roomId = decodeURIComponent(makeJoinRoute[1]);
        const userId = decodeURIComponent(makeJoinRoute[2]);
        if (domainOf(userId) !== origin) {
          throw new MatrixError(403, 'M_FORBIDDEN', 'not your user');
        }
        const room = await openParticipating(roomId);
        if (room === null) throw new MatrixError(404, 'M_NOT_FOUND', roomId);
        return Response.json(await membershipTemplate(room, userId, 'join'));
      }
      const sendJoinMatch =
        /^\/_matrix\/federation\/v2\/send_join\/([^/]+)\/([^/]+)$/
          .exec(path);
      if (sendJoinMatch && req.method === 'PUT') {
        const join = bodyJson as Pdu;
        (join as unknown as Record<string, unknown>).event_id =
          decodeURIComponent(sendJoinMatch[2]);
        return await sendJoinAnswer(
          decodeURIComponent(sendJoinMatch[1]),
          join,
          origin,
        );
      }
      const makeLeaveMatch =
        /^\/_matrix\/federation\/v1\/make_leave\/([^/]+)\/([^/]+)$/
          .exec(path);
      if (makeLeaveMatch && req.method === 'GET') {
        const roomId = decodeURIComponent(makeLeaveMatch[1]);
        const userId = decodeURIComponent(makeLeaveMatch[2]);
        const room = await openParticipating(roomId);
        if (room === null) throw new MatrixError(404, 'M_NOT_FOUND', roomId);
        return Response.json(await membershipTemplate(room, userId, 'leave'));
      }
      const sendLeaveMatch =
        /^\/_matrix\/federation\/v[12]\/send_leave\/([^/]+)\/([^/]+)$/
          .exec(path);
      if (sendLeaveMatch && req.method === 'PUT') {
        const leave = bodyJson as Pdu;
        (leave as unknown as Record<string, unknown>).event_id =
          decodeURIComponent(sendLeaveMatch[2]);
        const leaveRoomId = decodeURIComponent(sendLeaveMatch[1]);
        const room = await openParticipating(leaveRoomId);
        if (room === null) {
          throw new MatrixError(404, 'M_NOT_FOUND', leaveRoomId);
        }
        const outcomes = await ingestRemote(
          room,
          [leave],
          origin,
          remoteDepsOf(server, signer, name, store),
        );
        if (outcomes[0].outcome !== 'accepted') {
          throw new MatrixError(
            403,
            'M_FORBIDDEN',
            `leave not accepted: ${outcomes[0].outcome}`,
          );
        }
        return path.includes('/v2/')
          ? Response.json({})
          : Response.json([200, {}]);
      }
      const eventMatch = /^\/_matrix\/federation\/v1\/event\/([^/]+)$/.exec(
        path,
      );
      if (eventMatch && req.method === 'GET') {
        const id = decodeURIComponent(eventMatch[1]);
        const rows = await server.query(
          'SELECT room FROM event_index WHERE event = ?',
          [id],
        );
        if (rows.length === 0) throw new MatrixError(404, 'M_NOT_FOUND', id);
        const room = await openRoom(store, String(rows[0].room));
        const pdu = await room.tx(async (tx) => {
          const row = await tx.events.get(id);
          return row === null ? null : (JSON.parse(row.pdu) as Pdu);
        });
        if (pdu === null) throw new MatrixError(404, 'M_NOT_FOUND', id);
        const version = await room.tx(async (tx) => {
          const stay = await tx.segments.openStay();
          return stay === null ? '11' : await roomVersionOf(tx, stay.id);
        });
        return Response.json({
          origin: name,
          origin_server_ts: pdu.origin_server_ts,
          pdus: [toWire(pdu, version)],
        });
      }
      return Response.json(
        { errcode: 'M_UNRECOGNIZED', error: 'unknown endpoint' },
        { status: 404 },
      );
    } catch (e) {
      return errorOf(e);
    }
  };

  return instance;
}

// Recompute a wire PDU's event id (a received body carries none).
export async function idOf(pdu: Pdu, version = '11'): Promise<string> {
  return await eventIdFor(pdu as unknown as Record<string, unknown>, version);
}
