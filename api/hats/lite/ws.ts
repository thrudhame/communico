// api/hats/lite/ws.ts — WebSocket hub transport, server side of the lite
// hat. A room hub is a set of browser sockets; frames arrive as JSON
// envelopes tagged with the sender's socket id (`from`). No own-echo: a
// browser's frames go to the server peer only, and the peer's sends are
// broadcast to every socket in the room — a browser sees ONE peer: the
// server (plan §8: no reconnect/backoff, no auth — loopback demo).

export interface RoomHub {
  sockets: Map<string, WebSocket>;
  peerHandlers: {
    onPeer?: (peers: string[]) => void;
    onMessage?: (obj: unknown, bytes: undefined, from: string) => void;
  };
}

export function createHub(): RoomHub {
  return { sockets: new Map(), peerHandlers: {} };
}

export function hubAddSocket(
  hub: RoomHub,
  id: string,
  ws: WebSocket,
): void {
  hub.sockets.set(id, ws);
  hub.peerHandlers.onPeer?.([...hub.sockets.keys()]);
}

export function hubRemoveSocket(hub: RoomHub, id: string): void {
  hub.sockets.delete(id);
  hub.peerHandlers.onPeer?.([...hub.sockets.keys()]);
}

export function hubDeliver(hub: RoomHub, from: string, data: string): void {
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return; // non-JSON frame: not the protocol, drop
  }
  hub.peerHandlers.onMessage?.(obj, undefined, from);
}

export interface HubHandlers {
  onPeer?: (peers: string[]) => void;
  onMessage?: (obj: unknown, bytes: undefined, from: string) => void;
}

// The server peer's transport session over the hub (the LP3 transport
// interface): send = broadcast to every socket; peers = current socket
// ids; leave = detach handlers.
export function hubTransport(hub: RoomHub) {
  return {
    kind: 'ws-hub',
    // deno-lint-ignore require-await
    async join(_room: string, handlers: HubHandlers) {
      hub.peerHandlers = handlers;
      // Announce the current socket set on a MACROtask: msync's
      // session binding is assigned when the join() await resumes, so a
      // synchronous (or microtask) fire would hit its TDZ.
      setTimeout(() => handlers.onPeer?.([...hub.sockets.keys()]), 0);
      return {
        id: 'server',
        send(obj: unknown) {
          const data = JSON.stringify(obj);
          for (const ws of hub.sockets.values()) {
            try {
              ws.send(data);
            } catch { /* socket closing */ }
          }
        },
        peers: () => [...hub.sockets.keys()],
        leave() {
          hub.peerHandlers = {};
        },
      };
    },
  };
}
