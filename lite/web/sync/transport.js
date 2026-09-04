// sync/transport.js — byte-transport interface + BroadcastChannel adapter.
// The transport is a dumb pipe: it moves JSON envelopes + optional binary
// payloads between tabs/machines. Dolt sync lives entirely above it.
//
// Interface: createTransport(kind) → adapter
//   adapter.join(room, {onPeer, onMessage}) → session
//   session.send(obj, bytes?)  — obj: JSON-able envelope; bytes: ArrayBuffer
//   session.peers()            — array of peer ids currently known
//   session.leave()
//   onPeer(peers)              — fired when the peer set changes
//   onMessage(obj, bytes, from)— fired for each inbound message (never own echo)

export function createTransport(kind) {
  if (kind === 'broadcast') return createBroadcastTransport();
  if (kind === 'trystero') return createTrysteroTransport(); // sync/trystero.js (dynamic import)
  if (kind === 'ws') return createWsTransport();
  throw new Error(`unknown transport kind: ${kind}`);
}

// 'ws' — the lite-hat transport: the gres server's msync peer is the
// single peer (id 'server'). One socket per join, JSON envelopes only
// (msync needs no binary), no reconnect/backoff (demo scope, plan §8).
function createWsTransport() {
  return {
    kind: 'ws',
    join(room, { onPeer, onMessage }) {
      const ws = new WebSocket(
        `ws://${location.hostname}:8000/msync?room=${encodeURIComponent(room)}`,
      );
      const id = crypto.randomUUID();
      let opened = false;
      return new Promise((resolve, reject) => {
        ws.onopen = () => {
          opened = true;
          onPeer?.(['server']);
          resolve({
            id,
            send(obj) {
              ws.send(JSON.stringify(obj));
            },
            peers: () => (ws.readyState === WebSocket.OPEN ? ['server'] : []),
            leave() {
              try { ws.close(); } catch { /* closing anyway */ }
            },
          });
        };
        ws.onmessage = (ev) => {
          if (typeof ev.data !== 'string') return;
          let obj;
          try {
            obj = JSON.parse(ev.data);
          } catch { return; } // non-JSON: not the protocol
          onMessage?.(obj, undefined, 'server');
        };
        ws.onclose = () => {
          if (opened) onPeer?.([]);
        };
        ws.onerror = () => {
          if (!opened) reject(new Error('ws: connect failed'));
        };
      });
    },
  };
}

function createBroadcastTransport() {
  return {
    kind: 'broadcast',
    join(room, { onPeer, onMessage }) {
      const id = crypto.randomUUID();
      const ch = new BroadcastChannel(`communico-lite:${room}`);
      const known = new Map(); // peerId → lastSeen (no liveness timeout in v0 — recorded simplification)
      const notify = () => onPeer?.([...known.keys()]);
      ch.onmessage = (ev) => {
        const { from, to, ...obj } = ev.data ?? {};
        if (!from || from === id) return;              // never own echo
        if (to && to !== id) return;                   // addressed elsewhere
        const bytes = obj.bytes instanceof ArrayBuffer ? obj.bytes : undefined;
        delete obj.bytes;
        if (obj.t === 'hello') {
          if (!known.has(from)) { known.set(from, Date.now()); notify(); }
          ch.postMessage({ from: id, to: from, t: 'hello-ack' });
          return;
        }
        if (obj.t === 'hello-ack') {
          if (!known.has(from)) { known.set(from, Date.now()); notify(); }
          return;
        }
        if (obj.t === 'bye') {
          if (known.delete(from)) notify();
          return;
        }
        if (!known.has(from)) { known.set(from, Date.now()); notify(); }
        onMessage?.(obj, bytes, from);
      };
      ch.postMessage({ from: id, t: 'hello' });
      return {
        id,
        send(obj, bytes) {
          ch.postMessage({ ...obj, from: id, ...(bytes ? { bytes } : {}) });
        },
        peers: () => [...known.keys()],
        leave() {
          try { ch.postMessage({ from: id, t: 'bye' }); } catch { /* closing anyway */ }
          ch.close();
        },
      };
    },
  };
}

// Lazy so the BroadcastChannel path never pays the import (and CI never
// touches the network rails Trystero uses).
function createTrysteroTransport() {
  return {
    kind: 'trystero',
    async join(room, handlers) {
      const { createTrysteroSession } = await import('./trystero.js');
      return createTrysteroSession(room, handlers);
    },
  };
}
