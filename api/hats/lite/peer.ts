// api/hats/lite/peer.ts — the server's msync peer, one per room (the
// lite hat, design §4.4): the existing msync protocol implementation
// (lite/web/sync/msync.js — engine-neutral by import) over the gres
// engine facade, riding the ws hub transport. Per §3.6 the hat is a
// pure addition: it composes the core's ingest pipeline and applied
// signal, and changes nothing about them. The peer outlives sockets —
// "rooms outlive tabs" (§4.3).
import { getFacadeFor } from '../../engine/facade.ts';
import { onEventApplied } from '../../engine/ingest.ts';
import { startMsync } from '../../../lite/web/sync/msync.js';
import {
  createHub,
  hubAddSocket,
  hubDeliver,
  hubRemoveSocket,
  hubTransport,
  type RoomHub,
} from './ws.ts';

interface PeerEntry {
  hub: RoomHub;
  ready: Promise<void>;
}

const rooms = new Map<string, PeerEntry>();

async function startPeer(roomId: string, hub: RoomHub): Promise<void> {
  const facade = await getFacadeFor(roomId);
  if (!facade) {
    console.error(`lite peer: unknown room ${roomId} — sockets get no peer`);
    return;
  }
  const ms = await startMsync({
    engine: facade,
    transport: hubTransport(hub),
    roomName: roomId,
    onChange: undefined,
    onPeerTh: undefined,
    onPeers: undefined,
    onHeld: (held: unknown[]) =>
      console.error(`lite peer ${roomId}: ${held.length} events held after 3 rounds`),
  });
  // CS-hat sends (matrix-commander) → mirror update → announce, so
  // browsers see server-side events without polling (plan §3 step 9).
  onEventApplied((rid, eventId) => {
    if (rid !== roomId) return;
    void (async () => {
      await facade.noteApplied(eventId);
      await ms.announce();
    })().catch((e) => console.error('lite peer applied-signal:', e));
  });
}

export function attachSocket(roomId: string, ws: WebSocket): void {
  let entry = rooms.get(roomId);
  if (!entry) {
    const hub = createHub();
    entry = { hub, ready: startPeer(roomId, hub) };
    rooms.set(roomId, entry);
  }
  const { hub } = entry;
  const id = crypto.randomUUID();
  ws.onopen = () => hubAddSocket(hub, id, ws);
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') hubDeliver(hub, id, ev.data);
  };
  ws.onclose = () => hubRemoveSocket(hub, id);
}
