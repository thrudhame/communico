// sync/dsync.js — dolt-native sync (lite-v1 v1b). Peer sync is literally
// dolt pull: peers ship STORE BYTES over the same LP3 transport; the
// receiver mounts the image as a file:// remote in the WASM VFS, runs
// dolt_fetch, and heals via the LS3 driver merge (engine.adoptStoreImage).
//
// Envelope (Protocol "dolt v1"):
//   {t:'heads', room, tips:[eventId…], th:{engine,events,state}} —
//     convergence gossip: after every local ingest, on peer appear, and
//     after every applied store. (tips feed the tips-set badge; th is the
//     convergence trigger, advisory-tagged with the engine name.)
//   {t:'want', room} — request the peer's store image.
//   {t:'store', room, hasBytes:true, branches:[aliveBranch…]} + binary store
//     bytes. (branches are named explicitly: dolt_branches does not enumerate
//     remote refs — LB3b. Tristero splits envelope/bytes across two actions,
//     so a bare payload arrives as the adapter's synthetic {t:'bin'} — the
//     branch list then comes from branchesInImage on the receiver.)
// Convergence rule: want when the peer's th differs from ours (or we hold
// no events); one outstanding want per peer, re-armed on fresh heads;
// gossip settles when th equal.
// Modes do not interoperate (msync and dolt envelopes ignore each other) —
// recorded limitation.

export async function startDsync({ engine, transport, roomName, joiner = false, onChange, onPeerTh, onPeers, onHeld }) {
  const stats = { sent: 0, received: 0, applied: 0, merges: 0, stores: 0, badEvents: 0 };
  const outstandingWant = new Set(); // peer ids with an unanswered want
  let paused = false;
  const queue = [];
  let applying = Promise.resolve();    // serialize store application

  function send(obj, bytes) {
    if (paused) { queue.push([obj, bytes]); return; }
    session.send(obj, bytes);
    stats.sent++;
  }

  function announce() {
    const room = engine.getRoom();
    if (!room || room.eventIndex.size === 0) return;
    // tips ride the gossip for the tips-set convergence badge (same
    // contract as msync's announce); th stays the convergence trigger.
    send({
      t: 'heads', room: roomName,
      tips: engine.extremities(room).map((e) => e.eventId),
      th: { engine: engine.engineName, ...engine.tableHashes(room) },
    });
  }

  function want(from) {
    if (outstandingWant.has(from)) return;
    outstandingWant.add(from);
    send({ t: 'want', room: roomName });
  }

  async function applyStore(from, branches, bytes) {
    const room = engine.getRoom();
    if (!room || !bytes) return;
    stats.stores++;
    // trystero's bin path carries no branch list — fall back to reading the
    // peer image's own x-branch names (they are its alive extremity tips).
    let list = branches;
    if (!list?.length) {
      list = await engine.branchesInImage(bytes);
    }
    await engine.adoptStoreImage(room, new Uint8Array(bytes), from, list);
    stats.applied++;
    stats.merges = room.merges;
    onChange?.();
    announce(); // healed state is new gossip
  }

  const bootstrapped = () => {
    const room = engine.getRoom();
    return !!room && room.eventIndex.size > 0;
  };

    // joiner/pausing semantics (MS4 lesson): a peer appearing while we are
    // unbootstrapped triggers an immediate want (timer-independent); the
    // flood below is admission-of-disbelief — arrival means peer.
  const handlePeer = (peers) => {
    onPeers?.(peers);
    if (peers.length && engine.getRoom()) announce();
    if (joiner && peers.length && !bootstrapped()) send({ t: 'want', room: roomName });
  };

  const session = await transport.join(roomName, {
    onPeer: handlePeer,
    onMessage: (obj, bytes, from) => {
      if (!obj || obj.room !== roomName) return;
      const room = engine.getRoom();
      if (obj.t === 'heads') {
        if (!room) return;
        onPeerTh?.(from, obj.th, obj.tips ?? []);
        outstandingWant.delete(from); // fresh gossip re-arms the want
        const mine = engine.tableHashes(room);
        if (!bootstrapped() || obj.th?.events !== mine.events || obj.th?.state !== mine.state) {
          want(from);
        }
      } else if (obj.t === 'want') {
        if (!room || room.eventIndex.size === 0) return; // nothing worth shipping yet
        engine.exportStoreImage(room).then((img) => {
          send({ t: 'store', room: roomName, hasBytes: true, branches: engine.aliveBranches(room) },
            img.buffer.slice(img.byteOffset, img.byteOffset + img.byteLength));
        });
      } else if (obj.t === 'bin' && bytes) {
        // trystero origin: the adapter splits envelope/bytes across two
        // actions and synthesizes t:'bin' for a bare payload — the store
        // case is the only binary sender in this protocol.
        outstandingWant.delete(from);
        stats.received++;
        applying = applying.then(() => applyStore(from, null, bytes))
          .catch((e) => onHeld?.([{ storeFrom: from, error: String(e?.message ?? e) }]));
      } else if ((obj.t === 'store' || obj.bytes) && bytes) {
        // BC origin (bytes inside the envelope) or a store with the
        // envelope delivered first on trystero.
        outstandingWant.delete(from);
        stats.received++;
        applying = applying.then(() => applyStore(from, obj.branches, bytes))
          .catch((e) => onHeld?.([{ storeFrom: from, error: String(e?.message ?? e) }]));
      }
    },
  });

  // Joiner bootstrap: flood only while it matters (MS4 lesson, now
  // load-bearing in dolt mode — a whole store image has to arrive, not one
  // delta). outstandingWant keeps the request bounded; bootstrapped() ends
  // the loop once the store lands.
  let left = false;
  if (joiner) {
    const ask = () => {
      if (left || bootstrapped()) return;
      send({ t: 'want', room: roomName });
      setTimeout(ask, 2000);
    };
    ask();
  }

  return {
    announceLocalIngest: announce, // call after every local ingest
    announce,
    stats: () => ({ ...stats }),
    peers: () => session.peers(),
    pause(v) {
      paused = v;
      if (!v) { const q = queue.splice(0); for (const [m, b] of q) send(m, b); }
    },
    leave() { left = true; try { session.leave(); } catch { /* closing anyway */ } },
  };
}
