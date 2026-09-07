// sync/msync.js — matrix-sync Protocol v1 (plan §3 NORMATIVE).
// Envelope over the LP3 transport interface:
//   {t:'tips', room, tips:[eventId…], th:{engine,events,state}} — after
//     every local ingest and every applied delta; th = table hashes
//     (cheap convergence gossip, ADVISORY: only comparable when
//     th.engine matches — cross-engine peers can never match).
//   {t:'delta-req', room, tips:[…]} — on received tips with unknown ids
//     (or on join with tips:[]).
//   {t:'delta', room, events:[canonicalEvent…]} — topologically sorted,
//     full missing suffix relative to the requester's tips.
// Apply: verify eventIdFor(evt) === evt.event_id (reject + record),
// ingest in topo order with (origin_ts, event_id) tiebreak, ignore known
// ids, equal-th short-circuit, one outstanding delta-req per peer,
// re-request held events ≤3 rounds.
// NO store images, NO dolt remotes anywhere — events only.
//
// ENGINE SEAM: every engine-state read goes through the facade
// (engine.*) with await-tolerant calls — sync passthroughs in the
// browser, async SQL on the server hat. msync never touches room.*
// internals. Facade contract:
//   engineName                    — 'doltlite' | 'doltgres' (th tag)
//   getRoom()                     — room handle | null (sync)
//   extremities(room)             → [{eventId, branch}]
//   tableHashes(room)             → {events, state}
//   stateHash(room)               → sh digest | null (absent on contest)
//   roomVersion(room)             → '11'
//   ingestRemote(room, evt)       → {applied|held|known|bad|refused}
//   allEvents(room)               → [canonicalEvent…] (parsed)
//   hasEvent(room, id)            → bool
//   eventCount(room)              → number
//   badEvents(room)/merges(room)  → numbers (stats mirrors)

export async function startMsync({ engine, transport, roomName, joiner = false, onChange, onPeerTh, onHeld, onPeers }) {
  const stats = { sent: 0, received: 0, applied: 0, held: 0, badEvents: 0, merges: 0 };
  const outstandingReq = new Set();   // peer ids with an unanswered delta-req
  const reqRounds = new Map();        // peer id → re-request rounds used (≤3)
  let paused = false;
  const queue = [];

  function send(obj) {
    if (paused) { queue.push(obj); return; }
    session.send(obj);
    stats.sent++;
  }

  async function announce() {
    const room = engine.getRoom();
    if (!room) return;
    // th carries the engine-neutral sh digest + room_version (F0-8) next
    // to the engine-tagged table hashes. sh is ABSENT on contested keys
    // under the stub — absent, not different.
    const sh = await engine.stateHash?.(room);
    const roomVersion = await engine.roomVersion?.(room);
    send({
      t: 'tips', room: roomName,
      tips: (await engine.extremities(room)).map((e) => e.eventId),
      th: {
        engine: engine.engineName,
        ...(await engine.tableHashes(room)),
        ...(sh ? { sh } : {}),
        ...(roomVersion ? { room_version: roomVersion } : {}),
      },
    });
  }

  // past-cone of the given tip ids over the events' prev links
  async function pastCone(room, tipIds) {
    const byId = new Map((await engine.allEvents(room)).map((e) => [e.event_id, e]));
    const seen = new Set();
    const stack = [...tipIds];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const e = byId.get(id);
      if (e) for (const p of e.prev_events ?? []) stack.push(p);
    }
    return seen;
  }

  // topo sort (prevs first), deterministic tiebreak (origin_ts, event_id)
  function topo(events, knownToPeer) {
    const missing = new Map(events.map((e) => [e.event_id, e]));
    const emitted = new Set();
    const out = [];
    const cmp = (a, b) => a.origin_server_ts - b.origin_server_ts || (a.event_id < b.event_id ? -1 : 1);
    for (;;) {
      const ready = [...missing.values()].filter((e) =>
        (e.prev_events ?? []).every((p) => knownToPeer.has(p) || emitted.has(p) || !missing.has(p)));
      if (!ready.length) break;
      ready.sort(cmp);
      const e = ready[0];
      out.push(e);
      emitted.add(e.event_id);
      missing.delete(e.event_id);
    }
    return out; // (any remainder would be a cycle — impossible in a DAG)
  }

  async function computeDelta(room, requesterTips) {
    const all = await engine.allEvents(room);
    const knownToPeer = new Set();
    for (const id of requesterTips) {
      if (await engine.hasEvent(room, id)) knownToPeer.add(id);
    }
    if (requesterTips.length === 0 || knownToPeer.size !== requesterTips.length) {
      return topo(all, new Set()); // empty/unknown tips → full history
    }
    const have = await pastCone(room, requesterTips);
    return topo(all.filter((e) => !have.has(e.event_id)), have);
  }

  async function onDelta(from, events) {
    const room = engine.getRoom();
    if (!room) return;
    stats.received += events.length;
    let applied = 0;
    let stored = 0; // applied + refused-but-stored (F0 stub: rejected
    // events land in the DAG, out of state — still new tips to render
    // and gossip; refusal is materialization, never a propagation drop)
    const held = [];
    for (const evt of events) {
      const r = await engine.ingestRemote(room, evt);
      if (r.applied) { applied++; stored++; }
      else if (r.refused) stored++;
      else if (r.held) held.push(evt);
    }
    // retry held: prevs may have arrived later in the same batch
    let progress = true;
    while (progress && held.length) {
      progress = false;
      for (let i = held.length - 1; i >= 0; i--) {
        const r = await engine.ingestRemote(room, held[i]);
        if (r.applied) { applied++; stored++; held.splice(i, 1); progress = true; }
        else if (r.refused) { stored++; held.splice(i, 1); progress = true; }
      }
    }
    stats.applied += applied;
    stats.held = held.length;
    stats.badEvents = await engine.badEvents(room);
    stats.merges = await engine.merges(room);
    if (stored > 0) {
      onChange?.();
      await announce(); // apply-then-announce (stored refusals gossip too)
    }
    if (held.length) {
      const rounds = (reqRounds.get(from) ?? 0) + 1;
      reqRounds.set(from, rounds);
      if (rounds <= 3) {
        send({ t: 'delta-req', room: roomName, tips: (await engine.extremities(room)).map((e) => e.eventId) });
      } else {
        onHeld?.(held); // surface: stuck after 3 rounds
      }
    }
  }

  let left = false;
  const bootstrapped = async () => {
    const room = engine.getRoom();
    return !!room && (await engine.eventCount(room)) > 0;
  };
  const askBootstrap = () => {
    send({ t: 'delta-req', room: roomName, tips: [] }); // cheap by design
  };

  const session = await transport.join(roomName, {
    onPeer: (peers) => {
      void (async () => {
        onPeers?.(peers);
        if (peers.length && engine.getRoom()) await announce(); // a newcomer may need our heads
        // MS4: event-driven joiner rescue — a peer appearing while we are
        // unbootstrapped triggers an immediate delta-req (timer-independent).
        if (joiner && peers.length && !(await bootstrapped())) askBootstrap();
      })().catch((e) => console.error('msync onPeer:', e));
    },
    onMessage: (obj, _bytes, from) => {
      void (async () => {
        if (!obj || obj.room !== roomName) return;
        const room = engine.getRoom();
        if (obj.t === 'tips') {
          if (!room) return;
          onPeerTh?.(from, obj.th, obj.tips ?? []);
          const unknown = [];
          for (const id of obj.tips ?? []) {
            if (!(await engine.hasEvent(room, id))) unknown.push(id);
          }
          if (unknown.length === 0) return; // all known → equal-th short-circuit no-op
          if (!outstandingReq.has(from)) {
            outstandingReq.add(from);
            send({ t: 'delta-req', room: roomName, tips: (await engine.extremities(room)).map((e) => e.eventId) });
          }
        } else if (obj.t === 'delta-req') {
          if (!room) return;
          send({ t: 'delta', room: roomName, events: await computeDelta(room, obj.tips ?? []) });
        } else if (obj.t === 'delta') {
          outstandingReq.delete(from);
          reqRounds.delete(from);
          await onDelta(from, obj.events ?? []);
        }
      })().catch((e) => console.error('msync onMessage:', e));
    },
  });

  // Join = delta-req with empty tips (§3): full history, genesis-first.
  // MS4: UNCAPPED 2 s-cadence retry until bootstrapped or leave() —
  // slow transport discovery is a real race, not a reason to give up.
  if (joiner) {
    const ask = () => {
      void (async () => {
        if (left || (await bootstrapped())) return;
        askBootstrap();
        setTimeout(ask, 2000);
      })().catch((e) => console.error('msync ask:', e));
    };
    ask();
  }

  return {
    announceLocalIngest: announce, // call after every local ingest
    announce,
    stats: () => ({ ...stats }),
    peers: () => session.peers(), // exposed for the MS4 load smoke (CI checks callability only)
    pause(v) {
      paused = v;
      if (!v) { const q = queue.splice(0); for (const m of q) send(m); }
    },
    leave() { left = true; try { session.leave(); } catch { /* closing anyway */ } },
  };
}
