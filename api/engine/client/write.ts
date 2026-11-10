// C-S composition of the room core and tenant transaction receipts.
import { theApp } from '#engine/app.ts';
import { assertCanonicalNumbers, canonicalJson } from '#engine/canonical.ts';
import { serverName } from '#engine/config.ts';
import { productionKeyResolver } from '#engine/federation/keyresolver.ts';
import { inviteRemote } from '#engine/federation/invites.ts';
import { domainOf } from '#engine/federation/pdu.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import {
  createRoom as create,
  type CreateRoomOptions,
} from '#engine/room/create.ts';
import { redactEvent as redact, sendLocal } from '#engine/room/ingest.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import { ruleId } from '#engine/rulebook/rule-ids.ts';
import { membershipOf } from '#engine/server/read.ts';
import { lookupAlias, registerAlias } from '#engine/server/aliases.ts';
import { deviceIdentity, transactionSubmission } from '#engine/tenant/txns.ts';
import { localpartOf } from '#engine/ids.ts';
import { getProfile } from '#engine/tenant/users.ts';
import { requireRoom, stateAtSeq, versionOf } from './room.ts';

export type { CreateRoomOptions };

export function inviteDeps() {
  const app = theApp();
  const signer = app.tenant.signer();
  return {
    store: app.store,
    server: app.server,
    signer,
    keys: productionKeyResolver(app.server, signer),
    self: serverName(),
    wake: (destination: string) => app.sender?.wake(destination),
  };
}

export async function createRoom(opts: CreateRoomOptions) {
  const app = theApp();
  const alias = opts.alias === undefined
    ? undefined
    : '#' + opts.alias + ':' + serverName();
  if (alias !== undefined && await lookupAlias(app.server, alias) !== null) {
    throw new MatrixError(409, 'M_ROOM_IN_USE', 'alias taken: ' + alias);
  }
  const creatorProfile = await getProfile(
    app.tenant,
    localpartOf(opts.creator),
  );
  const res = await create(app.store, {
    ...opts,
    creatorProfile: creatorProfile ?? {},
  }, app.tenant.signer());
  if (res.roomAlias !== undefined) {
    await registerAlias(app.server, res.roomAlias, res.roomId, opts.creator);
  }
  if (opts.visibility === 'public') {
    await app.server.execute(
      'INSERT INTO visibility(room_id, visibility) VALUES(?,?)',
      [res.roomId, 'public'],
    );
  }
  for (const u of opts.invite ?? []) {
    if (domainOf(u) !== serverName()) {
      await inviteRemote(res.roomId, opts.creator, u, undefined, {
        isDirect: opts.is_direct,
      }, inviteDeps());
    }
  }
  return res;
}

export async function sendEvent(
  roomId: string,
  userId: string,
  type: string,
  content: Record<string, unknown>,
  deviceId: string | null,
  txnId: string,
  deviceGeneration?: number,
) {
  const app = theApp();
  const room = await requireRoom(roomId);
  const res = await sendLocal(
    room,
    {
      type,
      sender: userId,
      content,
      origin_server_ts: Date.now(),
    },
    app.tenant.signer(),
    transactionSubmission(
      app.tenant,
      deviceId === null ? null : await deviceIdentity(
        app.tenant,
        localpartOf(userId),
        deviceId,
        deviceGeneration,
      ),
      {
        kind: 'send',
        roomId,
        eventType: type,
      },
      txnId,
    ),
  );
  if (res.standing === 'rejected') {
    throw new MatrixError(
      403,
      'M_STATE_REJECT',
      `M_${
        res.reason === 'auth' ? 'AUTHCHAIN' : 'STATE'
      }_REJECT (rule ${res.rule})`,
    );
  }
  return { event_id: res.eventId };
}

export async function writeStateKey(
  roomId: string,
  userId: string,
  type: string,
  stateKey: string,
  content: Record<string, unknown>,
) {
  const room = await requireRoom(roomId);
  if (type === 'm.room.create') {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'm.room.create cannot be sent after creation',
    );
  }
  if (
    (await membershipOf(theApp().server, roomId, userId))?.membership !== 'join'
  ) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'not joined to ' + roomId);
  }
  assertCanonicalNumbers(content);
  const cur = (await stateAtSeq(roomId, null)).find((r) =>
    r.type === type && r.stateKey === stateKey
  );
  if (cur) {
    const row = await room.tx((tx) => tx.events.get(cur.eventId));
    const pdu = row === null ? null : JSON.parse(row.pdu) as Pdu;
    if (
      pdu?.sender === userId &&
      canonicalJson(pdu.content ?? {}) === canonicalJson(content)
    ) return { event_id: cur.eventId };
  }
  const res = await sendLocal(room, {
    type,
    state_key: stateKey,
    sender: userId,
    content,
    origin_server_ts: Date.now(),
  }, theApp().tenant.signer());
  if (res.standing === 'rejected') {
    const spec = getRulebook(await versionOf(room)).spec;
    const msg = `M_${
      res.reason === 'auth' ? 'AUTHCHAIN' : 'STATE'
    }_REJECT (rule ${res.rule})`;
    if (
      spec.creatorsHaveInfinitePower &&
      res.rule === ruleId(spec, 'pl.creator_in_users')
    ) {
      throw new MatrixError(400, 'M_INVALID_PARAM', msg);
    }
    throw new MatrixError(403, 'M_FORBIDDEN', msg);
  }
  return { event_id: res.eventId };
}

export async function redactEvent(
  roomId: string,
  userId: string,
  target: string,
  reason: string | undefined,
  deviceId: string | null,
  txnId: string,
  deviceGeneration?: number,
) {
  const app = theApp();
  const room = await requireRoom(roomId);
  const res = await redact(
    room,
    userId,
    target,
    app.tenant.signer(),
    reason,
    transactionSubmission(
      app.tenant,
      deviceId === null ? null : await deviceIdentity(
        app.tenant,
        localpartOf(userId),
        deviceId,
        deviceGeneration,
      ),
      {
        kind: 'redact',
        roomId,
        eventId: target,
      },
      txnId,
    ),
  );
  return res;
}
