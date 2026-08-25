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
  throw new Error(`unknown transport kind: ${kind}`);
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
