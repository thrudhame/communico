// api/engine/room/join.ts — joining a room hosted elsewhere (3c-2):
// make_join → build the join from the resident's template → sign →
// send_join → the returned snapshot is validated BEFORE anything is
// written (state/auth-chain events through the ONE verification path:
// unverifiable events dropped, auth failures rejected and excluded from
// the snapshot; the returned join must
// match ours; the room file is only created after validation passes —
// plan §3). Then one room transaction under the per-room lock: the
// auth chain and state events stored as `evidence` (R2 — bytes, never
// state-at), the imported snapshot group built (provenance `imported`,
// R5/G1 — the boundary is stored, never recomputed from absent prevs),
// a new stay opened on it, the join ingested with before = the
// snapshot, extremities = [join], publication and the membership
// change logged. Via servers are tried in order — network failure,
// 5xx, 404 M_NOT_FOUND and M_UNABLE_TO_(AUTHORISE|GRANT)_JOIN fail
// over; other 4xx abort (the old classification). Network never runs
// under the lock (R13).
import { config } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import {
  getRulebook,
  type Rulebook,
  supportedRoomVersions,
} from '#engine/rulebook/index.ts';
import { finalizeBuilt, roomCreateId } from '#engine/room/build.ts';
import {
  type Fetcher,
  type KeyResolver,
  SendJoinRefused,
} from '#engine/room/deps.ts';
import {
  admitLocalJoin,
  projectAfterWrite,
  registerCreatedRoom,
} from '#engine/room/hooks.ts';
import { openRoom } from '#engine/room/index.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { AclDenied, assertServerAllowed } from '#engine/room/acl.ts';
import type { Signer } from '#engine/room/signer.ts';
import {
  authorizeSnapshotEvent,
  verifySnapshot,
} from '#engine/room/snapshot.ts';
import { installSnapshotBoundary } from '#engine/room/snapshot-install.ts';
import { identify } from '#engine/room/verify.ts';
import { authorizerServer } from '#engine/room/verify.ts';
import {
  recoverableUpstream,
  upstreamCategory,
  UpstreamHttpError,
} from '#engine/net/upstream-error.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import type { Store } from '#engine/store/index.ts';
import {
  assertJoinEncryption,
  assertKnownJoinEncryption,
} from '#engine/room/encryption-policy.ts';
import {
  beginJoinAttempt,
  clearJoinAttempt,
  type JoinAttempt,
  joinAttemptCommitted,
  releaseJoinAttempt,
} from '#engine/server/join-attempts.ts';

export type JoinDeps = {
  keys: KeyResolver;
  fetcher: Fetcher;
  self: string;
  leave?: (attempt: JoinAttempt) => Promise<void>;
  wake?: (destination: string) => void;
};

export type JoinResult = { roomId: string; eventId: string };

// Fail over to the next candidate on network failure, 5xx,
// 404 M_NOT_FOUND and the M_UNABLE_TO_* join errcodes; abort on other
// 4xx (403, M_INCOMPATIBLE_ROOM_VERSION — the old classification).
function isFailover(e: unknown): boolean {
  if (!(e instanceof MatrixError) && !(e instanceof UpstreamHttpError)) {
    return ['transport', 'protocol', 'validation'].includes(
      upstreamCategory(e),
    );
  }
  const err = e;
  if (err.status >= 500) return true;
  if (err.status === 404 && err.errcode === 'M_NOT_FOUND') return true;
  return err.errcode === 'M_UNABLE_TO_AUTHORISE_JOIN' ||
    err.errcode === 'M_UNABLE_TO_GRANT_JOIN';
}

// A candidate whose RESPONSE is untrusted fails over (502), like the
// old checkSnapshot.
function badResponse(message: string): MatrixError {
  return new MatrixError(502, 'M_UNKNOWN', message);
}

export async function joinRemote(
  store: Store,
  args: {
    roomId: string;
    user: string;
    via: string[];
    signer: Signer;
    deps: JoinDeps;
    content?: Record<string, unknown>;
  },
): Promise<JoinResult> {
  await assertKnownJoinEncryption(store, args.roomId);
  let lastError: unknown = null;
  const until = Date.now() + 60_000;
  for (const candidate of [...new Set(args.via)].slice(0, 8)) {
    if (Date.now() > until) break;
    try {
      return await joinVia(store, args, candidate);
    } catch (e) {
      if (
        (e instanceof AclDenied && e.server !== args.deps.self) || isFailover(e)
      ) {
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  if (lastError !== null) throw lastError;
  throw new MatrixError(404, 'M_NOT_FOUND', 'no servers to join through');
}

async function joinVia(
  store: Store,
  args: {
    roomId: string;
    user: string;
    signer: Signer;
    deps: JoinDeps;
    content?: Record<string, unknown>;
  },
  candidate: string,
): Promise<JoinResult> {
  const { deps } = args;

  // 1. make_join — the resident's template names the room's version
  const mk = await deps.fetcher.makeJoin(
    args.roomId,
    args.user,
    supportedRoomVersions(),
    candidate,
  );
  let rulebook: Rulebook;
  try {
    rulebook = getRulebook(mk.roomVersion);
  } catch {
    throw new MatrixError(
      400,
      'M_INCOMPATIBLE_ROOM_VERSION',
      `This server does not know how to join a room of version ${mk.roomVersion}`,
    );
  }

  // 2. build the join from the template (the resident's prevs, auth
  //    events and depth; our content) and sign it
  const template = mk.event;
  if (
    template.type !== 'm.room.member' || template.room_id !== args.roomId ||
    template.sender !== args.user || template.state_key !== args.user ||
    template.content?.membership !== 'join' ||
    !Array.isArray(template.prev_events) ||
    !Array.isArray(template.auth_events) ||
    !Number.isSafeInteger(template.depth)
  ) {
    throw badResponse('invalid make_join template identity or shape');
  }
  let authorizer: string | null;
  try {
    authorizer = authorizerServer(template, mk.roomVersion);
  } catch {
    throw badResponse('invalid make_join authorizer');
  }
  if (authorizer !== null && authorizer !== candidate) {
    throw badResponse('make_join authorizer is not on the resident');
  }
  const content = { ...args.content, membership: 'join' } as Record<
    string,
    unknown
  >;
  delete content.join_authorised_via_users_server;
  if (authorizer !== null) {
    content.join_authorised_via_users_server =
      template.content.join_authorised_via_users_server;
  }
  const pdu: Pdu = {
    type: 'm.room.member',
    state_key: args.user,
    sender: args.user,
    room_id: args.roomId,
    content,
    prev_events: template.prev_events ?? [],
    auth_events: template.auth_events ?? [],
    depth: template.depth ?? 1,
    origin_server_ts: Date.now(),
    hashes: { sha256: '' },
    signatures: {},
  };
  const signed = await finalizeBuilt(pdu, rulebook, args.signer);
  const eventId = String(signed.event_id);

  // Outstanding compensation fences every new membership side effect, even
  // after policy changes. Durable recording below remains strict-policy only.
  await withRoomLock(
    args.roomId,
    () => admitLocalJoin(store, args.roomId, args.user),
  );
  const attempt: JoinAttempt | null =
    config().encryption.allowunencryptedjoining ? null : {
      roomId: args.roomId,
      userId: args.user,
      eventId,
      roomVersion: mk.roomVersion,
      destination: candidate,
      addedMs: Date.now(),
    };
  if (attempt !== null) await beginJoinAttempt(store, attempt);
  let refused = false;
  try {
    // 3. send_join — the answer is untrusted input
    const resp = await deps.fetcher.sendJoin(args.roomId, signed, candidate)
      .catch((error: unknown) => {
        refused = error instanceof SendJoinRefused;
        throw error;
      });

    // 4. validate BEFORE anything is written: individual receipt failures
    //    drop events, auth failures reject them. Only accepted state enters
    //    the boundary; the join must still be authorized by that snapshot.
    const verified = await verifySnapshot({
      roomId: args.roomId,
      roomVersion: mk.roomVersion,
      resident: candidate,
      self: deps.self,
      keys: deps.keys,
      state: resp.state ?? [],
      authChain: resp.authChain ?? [],
    });
    const { pack, snapshot, createId } = verified;
    // The returned join must match ours. Merge only its verified resident
    // signature into our authored event. The countersigned
    // copy is required only for restricted authorisation (joins-v2.yaml).
    // Decide from OUR content, even when the response omits the event.
    let join = signed;
    let vouched = false;
    if (resp.event !== undefined) {
      const returned = resp.event;
      let identifiedId: string;
      try {
        identifiedId = (await identify(returned, mk.roomVersion, {
          roomId: args.roomId,
        })).eventId;
      } catch (e) {
        throw badResponse('the returned join is malformed: ' + String(e));
      }
      if (identifiedId !== eventId) {
        throw badResponse('the returned join does not match ours');
      }
      const residentSigs = (returned.signatures as
        | Record<string, Record<string, string>>
        | undefined)?.[candidate] ?? {};
      const verifiedSigs: Record<string, string> = {};
      for (const keyId of Object.keys(residentSigs)) {
        try {
          if (
            await deps.keys.verifyEventSignature({
              server: candidate,
              keyId,
              pdu: returned,
              roomVersion: mk.roomVersion,
              minValidUntilMs: rulebook.spec.enforceKeyValidity
                ? signed.origin_server_ts
                : 0,
            })
          ) {
            verifiedSigs[keyId] = residentSigs[keyId];
            break;
          }
        } catch (error) {
          if (!recoverableUpstream(error)) throw error;
          // key unobtainable under this id — try the next
        }
      }
      vouched = Object.keys(verifiedSigs).length > 0;
      if (vouched) {
        join = {
          ...signed,
          signatures: {
            ...signed.signatures,
            [candidate]: {
              ...signed.signatures?.[candidate],
              ...verifiedSigs,
            },
          },
        };
      }
    }
    if (
      signed.content?.join_authorised_via_users_server !== undefined && !vouched
    ) {
      throw badResponse('the returned join is not vouched by the resident');
    }
    // the join against the snapshot: its auth events and the state before
    await authorizeSnapshotEvent(join, mk.roomVersion, verified);

    const aclId = snapshot.get('m.room.server_acl\0');
    const acl = aclId === undefined ? null : pack.get(aclId)?.content ?? {};
    assertServerAllowed(deps.self, acl);
    assertServerAllowed(candidate, acl);
    const encryptionId = snapshot.get('m.room.encryption\0');
    assertJoinEncryption(
      encryptionId === undefined ? undefined : pack.get(encryptionId)?.content,
    );

    let held = null;
    try {
      held = await openRoom(store, args.roomId);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (
      held !== null && await held.tx((tx) => tx.segments.openStay()) !== null
    ) {
      // Already resident does not mean able to vouch. Land the remote vouch
      // through normal verified recovery into this stay, never install its
      // send_join snapshot over our published state or open a second stay.
      const outcomes = await ingestRemote(held, [join], candidate, {
        keys: deps.keys,
        fetcher: deps.fetcher,
        self: deps.self,
        limits: {
          waitMs: config().federation.missingwaitms,
          limit: config().federation.missinglimit,
          budgetMs: config().federation.missingbudgetms,
        },
        ungroundedMs: 0,
        localJoin: { eventId, userId: args.user },
      }, 'pulled');
      const landed = await held.tx(async (tx) => {
        const status = await tx.events.getStatus(eventId);
        return status?.standing === 'accepted' &&
          status.grounding === 'grounded';
      });
      if (!landed) {
        throw badResponse(
          'resident remote join did not land: ' + JSON.stringify(outcomes),
        );
      }
      return { roomId: args.roomId, eventId };
    }

    // 5. the room file (safe create when absent — validation has passed),
    //    then ONE transaction (G11). room-first: the registry follows the
    //    file's existence (a crash between the two is the startup
    //    discovery's window).
    const room = await openRoom(store, args.roomId, { create: true });
    await registerCreatedRoom(store, args.roomId);
    await withRoomLock(args.roomId, () =>
      room.tx(async (tx) => {
        // revalidation (G8): a live stay means the room is already joined
        if ((await tx.segments.openStay()) !== null) {
          // /send may publish the same join while the dance is in flight.
          // Reconcile its original receipt, not the returned snapshot.
          const existing = await tx.events.getStatus(eventId);
          if (
            existing?.standing === 'accepted' &&
            existing.grounding === 'grounded'
          ) return;
          throw new MatrixError(
            400,
            'M_BAD_STATE',
            'room became resident during join',
          );
        }
        const prevStay = (await tx.segments.list())
          .filter((segment) => segment.kind === 'stay')
          .pop() ?? null;
        if (
          prevStay !== null &&
          await roomCreateId(tx, prevStay.id) !== createId
        ) {
          throw badResponse('snapshot replaces the room create');
        }

        await installSnapshotBoundary(tx, {
          roomId: args.roomId,
          roomVersion: mk.roomVersion,
          event: join,
          verified,
          resident: candidate,
          self: deps.self,
          previousStay: prevStay?.id ?? null,
        });
      }));
    await projectAfterWrite(store, args.roomId);
    return { roomId: args.roomId, eventId };
  } finally {
    if (attempt !== null) {
      try {
        if (refused || await joinAttemptCommitted(store, attempt)) {
          await clearJoinAttempt(await store.server(), attempt);
        } else if (deps.leave !== undefined) {
          await deps.leave(attempt);
          await clearJoinAttempt(await store.server(), attempt);
        }
      } catch (error) {
        // The durable intent survives failed cleanup or acknowledgment. Never
        // replace the original join refusal with a misleading cleanup success.
        console.warn('join cleanup remains pending:', String(error));
      } finally {
        releaseJoinAttempt(store, attempt);
        deps.wake?.(candidate);
      }
    }
  }
}
