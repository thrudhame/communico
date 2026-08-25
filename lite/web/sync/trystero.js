// sync/trystero.js — Trystero adapter for the LP3 transport interface
// (createTransport('trystero')). npm trystero@0.25.3 — the default entry
// (`./dist/index.mjs`) re-exports `@trystero-p2p/nostr`, so the default
// strategy is NOSTR (public nostr relays as serverless signaling; WebRTC
// DataChannels DTLS-encrypted peer-to-peer after discovery). Never used
// by CI for network behavior (human-gated); a LOAD smoke runs in CI per
// MS4/F-D1 (code paths must not ship unexecuted).
//
// MS4: the API below is the @trystero-p2p FORK shape (cited verbatim from
// node_modules/@trystero-p2p/core/dist/types.d.mts), NOT classic
// trystero: makeAction(ns) → OBJECT {send(data, opts?), onMessage,
// onReceiveProgress}; onPeerJoin/onPeerLeave are ASSIGNABLE properties;
// selfId is a MODULE export; handlers receive (data, context) with
// context.peerId.
//
// Interface contract (same as the BroadcastChannel adapter):
//   createTrysteroSession(room, {onPeer, onMessage}) → Promise<session>
//   session.send(obj, bytes?) / peers() / leave(); onPeer(ids);
//   onMessage(obj, bytes, from).
export async function createTrysteroSession(room, { onPeer, onMessage }) {
  const { joinRoom, selfId } = await import('trystero');
  const tr = joinRoom({ appId: 'communico-lite' }, room);
  const msgA = tr.makeAction('msg');
  const binA = tr.makeAction('bin');
  const notify = () => onPeer?.(Object.keys(tr.getPeers()));
  tr.onPeerJoin = notify;
  tr.onPeerLeave = notify;
  msgA.onMessage = (data, ctx) => onMessage?.(data, undefined, ctx.peerId);
  binA.onMessage = (data, ctx) => onMessage?.({ t: 'bin', room }, data, ctx.peerId);
  return {
    id: selfId,
    send(obj, bytes) { if (bytes) binA.send(bytes); else msgA.send(obj); },
    peers: () => Object.keys(tr.getPeers()),
    leave() { try { tr.leave(); } catch { /* closing anyway */ } },
  };
}
