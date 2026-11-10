// Room-scoped previews reuse room visibility, publication cuts and renderers.
import { theApp } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import { localpartOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { feedAfter, membershipOf } from '#engine/server/read.ts';
import { onProjected } from '#engine/server/project.ts';
import { eventStreamMax, onEventStream } from '#engine/server/stream.ts';
import { visibility } from '#engine/server/directory.ts';
import { listRoomAccountData } from '#engine/tenant/accountdata.ts';
import { requireRoom, stateAtSeq } from './room.ts';
import { renderEvent } from './render.ts';
import { clientEventsForRows } from './state.ts';
import { messages } from './timeline.ts';
import { parseStreamToken } from './tokens.ts';

function forbidden(): never {
  throw new MatrixError(403, 'M_FORBIDDEN', 'no room preview available');
}
function invalid(message: string): never {
  throw new MatrixError(400, 'M_INVALID_PARAM', message);
}
export function peekNumber(
  raw: string | null,
  fallback: number,
  maximum: number,
) {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    invalid('invalid pagination value');
  }
  return Math.min(Number(raw), maximum);
}

// Caller holds the room lock so admission, cut and response cannot straddle a
// local visibility/departure transition. No network operation runs in this scope.
async function previewCut(roomId: string, user: string) {
  const app = theApp(), room = await requireRoom(roomId);
  const membership = await membershipOf(app.server, roomId, user);
  if (membership?.forgotten || membership?.membership === 'ban') forbidden();
  const head = await eventStreamMax(app.server);
  const cut = membership?.membership === 'leave'
    ? Math.min(membership.seq, head)
    : head;
  const state = await stateAtSeq(roomId, cut);
  const world =
    state.find((s) =>
      s.type === 'm.room.history_visibility' && s.stateKey === ''
    )?.content.history_visibility === 'world_readable';
  const departed = membership?.membership === 'leave' &&
    await room.tx(async (tx) => {
      const before = await tx.state.eventStateBefore(membership.eventId);
      const id = before === null
        ? null
        : await tx.state.groupKey(before.group, 'm.room.member', user);
      const row = id === null ? null : await tx.events.get(id);
      return row !== null && JSON.parse(row.pdu).content?.membership === 'join';
    });
  if (
    membership?.membership !== 'join' && !departed &&
    !world
  ) forbidden();
  return {
    room,
    cut,
    head,
    state,
    membership: membership?.membership ?? 'leave',
  };
}

export async function roomInitialSync(
  roomId: string,
  user: string,
  device: string | null,
  limit: number,
) {
  return await withRoomLock(roomId, async () => {
    const app = theApp(), snapshot = await previewCut(roomId, user);
    const page = await messages({
      roomId,
      userId: user,
      deviceId: device,
      leaveAt: snapshot.cut,
      dir: 'b',
      fromToken: 's' + snapshot.cut,
      toToken: null,
      limit,
      lazyLoadMembers: false,
      localOnly: true,
    });
    return {
      room_id: roomId,
      membership: snapshot.membership,
      messages: {
        chunk: page.chunk.reverse(),
        end: 's' + snapshot.cut,
        ...(page.end === undefined ? {} : { start: page.end }),
      },
      state: await clientEventsForRows(roomId, snapshot.state),
      visibility: await visibility(app.server, roomId),
      account_data: await listRoomAccountData(
        app.tenant,
        localpartOf(user),
        roomId,
      ),
    };
  });
}

export async function roomEvents(
  roomId: string,
  user: string,
  device: string | null,
  rawFrom: string | null,
  timeout: number,
  signal: AbortSignal,
) {
  if (!roomId.startsWith('!')) invalid('room_id is required');
  const parsed = parseStreamToken(rawFrom);
  if (rawFrom !== null && parsed === null) invalid('bad from token');
  const app = theApp();
  // An omitted cursor begins now, not at room genesis.
  let from = parsed?.eSeq ?? await eventStreamMax(app.server);
  const start = rawFrom ?? 's' + from;
  const deadline = Date.now() +
    Math.min(timeout, config().peeking.maxtimeoutms);
  while (true) {
    signal.throwIfAborted();
    let wake!: () => void;
    const changed = new Promise<void>((resolve) => {
      wake = resolve;
    });
    // Arm before the snapshot, including the first iteration. A write committed
    // while reading remains signalled; unrelated writes only trigger rechecking.
    const removeProjected = onProjected((store) => {
      if (store === app.store) wake();
    });
    const removeStream = onEventStream((path) => {
      if (path === app.server.path) wake();
    });
    signal.addEventListener('abort', wake, { once: true });
    const timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
    try {
      const result = await withRoomLock(roomId, async () => {
        const snapshot = await previewCut(roomId, user);
        const rows = await feedAfter(
          app.server,
          roomId,
          from,
          config().peeking.maxevents,
          snapshot.cut,
        );
        const chunk: Record<string, unknown>[] = [];
        for (const row of rows) {
          const event = await renderEvent(snapshot.room, row.event, {
            userId: user,
            deviceId: device,
            tenant: app.tenant,
          });
          if (event !== null) chunk.push(event);
        }
        const end = rows.length === config().peeking.maxevents
          ? rows.at(-1)!.seq
          : Math.max(from, snapshot.cut);
        return { chunk, end, more: rows.length === config().peeking.maxevents };
      });
      signal.throwIfAborted();
      if (result.chunk.length || Date.now() >= deadline) {
        return { chunk: result.chunk, start, end: 's' + result.end };
      }
      from = result.end;
      if (!result.more) await changed;
    } finally {
      clearTimeout(timer);
      removeProjected();
      removeStream();
      signal.removeEventListener('abort', wake);
    }
  }
}
