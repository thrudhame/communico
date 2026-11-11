// tests/room-redaction.test.ts — redactions (G13): the event's acceptance
// is separate from its effect. The old redact.test.ts's engine-observable
// contracts (own event redacts; a non-author below the redact level gets
// 403 from the op gate; an unknown target is authored and waits, not 404)
// plus the discriminating effect-permission cases the old tests never
// pinned (v3-handling-redactions.md: PL ≥ redact at the redaction's
// before-state, or matching sender domains). Rendering and txn
// idempotency belong to stage 5 (endpoints).
import { assert, assertEquals, assertRejects } from '@std/assert';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { roomSchema } from '#engine/room/index.ts';
import {
  ingestInTx,
  redactEvent,
  resumeWaits,
  sendLocal,
} from '#engine/room/ingest.ts';
import { buildInTx } from '#engine/room/build.ts';
import { join } from '#engine/room/membership.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { openStore } from '#engine/store/index.ts';
import { bobJoins, type Genesis, genesis } from './fixtures/genesis.ts';

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

async function withRoom(
  opts: { joinRule?: string },
  fn: (g: Genesis) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(config(dir), {
    schemas: { room: roomSchema },
  });
  try {
    await fn(await genesis(store, { roomId: '!red:test', ...opts }));
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function send(
  g: Genesis,
  sender: string,
  body: string,
  ts: number,
): Promise<string> {
  const r = await sendLocal(g.room, {
    type: 'm.room.message',
    sender,
    content: { body, msgtype: 'm.text' },
    origin_server_ts: ts,
  }, g.signer);
  assertEquals(r.standing, 'accepted');
  return r.eventId;
}

type ChangeView = {
  redactions: { event: string | null; data: { target?: unknown } }[];
};

async function redactionChanges(g: Genesis): Promise<ChangeView> {
  return await g.room.tx(async (tx) => ({
    redactions: (await tx.changes.after(0, 200))
      .filter((c) => c.kind === 'redaction')
      .map((c) => ({
        event: c.event,
        data: JSON.parse(c.data) as { target?: unknown },
      })),
  }));
}

Deno.test('redact: competing resume drivers consume one locked wait and publish one effect', async () => {
  await withRoom({}, async (g) => {
    const target = await g.room.tx((tx) =>
      buildInTx(tx, g.room.id, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body: 'arrives later' },
      }, g.signer)
    );
    const redaction = await redactEvent(
      g.room,
      g.creator,
      target.event_id!,
      g.signer,
    );
    await g.room.tx((tx) =>
      ingestInTx(tx, g.room.id, target, { self: g.signer.serverName })
    );
    const original = g.room.tx;
    let scanned = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    g.room.tx = async (fn) => {
      const result = await original(fn);
      if (
        result && typeof result === 'object' && 'kind' in result &&
        result.kind === 'redaction' && scanned < 2
      ) {
        if (++scanned === 2) release();
        await ready;
      }
      return result;
    };
    try {
      await Promise.all([
        resumeWaits(g.room, { self: 'test' }),
        resumeWaits(g.room, { self: 'test' }),
      ]);
    } finally {
      g.room.tx = original;
    }
    assertEquals((await redactionChanges(g)).redactions, [{
      event: redaction.eventId,
      data: { target: target.event_id },
    }]);
    assertEquals(await g.room.tx((tx) => tx.waits.of(redaction.eventId)), []);
  });
});

Deno.test('membership: local join resumes children waiting at its post-commit boundary', async () => {
  await withRoom({ joinRule: 'public' }, async (g) => {
    const original = g.room.tx;
    let child: string | undefined;
    g.room.tx = async (fn) => {
      const result = await original(fn);
      if (
        !child && result && typeof result === 'object' && 'created' in result &&
        result.created && 'eventId' in result
      ) {
        const parent = String(result.eventId);
        await original(async (tx) => {
          const pdu = await buildInTx(tx, g.room.id, {
            type: 'm.room.message',
            sender: g.creator,
            content: { body: 'waiting child' },
          }, g.signer);
          child = pdu.event_id!;
          await tx.events.insert(child, canonicalJson(pdu));
          await tx.events.setStatus(child, {
            standing: 'rejected',
            grounding: 'pending',
            origin: 'test',
            received_ts: Date.now(),
          });
          await tx.waits.add({
            missing: parent,
            waiting: child,
            kind: 'prev',
            since: Date.now(),
            expires: null,
            state: 'pending',
          });
        });
      }
      return result;
    };
    try {
      await join(g.room, '@bob:test', g.signer);
    } finally {
      g.room.tx = original;
    }
    assert(child);
    assertEquals(
      (await g.room.tx((tx) => tx.events.getStatus(child!)))?.grounding,
      'grounded',
    );
    assertEquals(await g.room.tx((tx) => tx.waits.of(child!)), []);
  });
});

Deno.test('redact: own event redacts — the effect lands; the target PDU is untouched', async () => {
  await withRoom({}, async (g) => {
    const target = await send(g, g.creator, 'redact me', 1000);
    const before = await g.room.tx(async (tx) =>
      (await tx.events.get(target))!.pdu
    );
    const { eventId } = await redactEvent(
      g.room,
      g.creator,
      target,
      g.signer,
      'reasons...',
    );
    // the redaction event is accepted, v11 carries redacts under content
    await g.room.tx(async (tx) => {
      const row = (await tx.events.get(eventId))!;
      const pdu = JSON.parse(row.pdu) as Pdu;
      assertEquals(pdu.type, 'm.room.redaction');
      assertEquals(pdu.content.redacts, target);
    });
    // the effect applied (own event — matching sender domain)
    const view = await redactionChanges(g);
    assertEquals(view.redactions.length, 1);
    assertEquals(view.redactions[0].event, eventId);
    assertEquals(view.redactions[0].data.target, target);
    // R1: the target's stored PDU is never modified
    await g.room.tx(async (tx) => {
      assertEquals((await tx.events.get(target))!.pdu, before);
    });
  });
});

Deno.test('redact: a non-author below the redact level gets 403; own event needs only the event level', async () => {
  await withRoom({ joinRule: 'public' }, async (g) => {
    await bobJoins(g);
    const target = await send(g, g.creator, 'alice says', 1000);
    // bob (PL 0) redacts alice's event -> 403 M_FORBIDDEN (op gate)
    const denied = await assertRejects(() =>
      redactEvent(g.room, '@bob:test', target, g.signer)
    );
    assert(denied instanceof MatrixError);
    assertEquals(denied.status, 403);
    assertEquals(denied.errcode, 'M_FORBIDDEN');
    // bob redacts his OWN event -> allowed (event level 0)
    const own = await send(g, '@bob:test', 'bob says', 1001);
    const { eventId } = await redactEvent(g.room, '@bob:test', own, g.signer);
    const view = await redactionChanges(g);
    assertEquals(view.redactions.length, 1);
    assertEquals(view.redactions[0].event, eventId);
    assertEquals(view.redactions[0].data.target, own);
  });
});

Deno.test('redact: an unknown target is authored and waits, not 404 (R10)', async () => {
  await withRoom({}, async (g) => {
    const unknownId = '$does-not-exist:anywhere.test';
    const { eventId } = await redactEvent(
      g.room,
      g.creator,
      unknownId,
      g.signer,
      'moderation',
    );
    // the redaction event is accepted into the room
    await g.room.tx(async (tx) => {
      const row = (await tx.events.get(eventId))!;
      assertEquals((JSON.parse(row.pdu) as Pdu).content.redacts, unknownId);
      // and a waits entry records the delayed effect
      const waits = await tx.waits.of(eventId);
      assertEquals(waits.length, 1);
      assertEquals(waits[0].missing, unknownId);
      assertEquals(waits[0].kind, 'redaction');
      assertEquals(waits[0].expires, null);
    });
    // no effect entry without a held target
    const view = await redactionChanges(g);
    assertEquals(view.redactions.length, 0);
  });
});

Deno.test('redact (G13): a redactor at the redact level applies the effect to another server’s event', async () => {
  await withRoom({ joinRule: 'public' }, async (g) => {
    await bobJoins(g, '@bob:remote.test');
    const target = await send(g, '@bob:remote.test', 'remote says', 1001);
    // dev (PL 100 ≥ redact 50) redacts the remote user's event through the
    // op — the own-event discount does not apply, the redact level does
    const { eventId } = await redactEvent(g.room, g.creator, target, g.signer);
    const view = await redactionChanges(g);
    assertEquals(view.redactions.length, 1);
    assertEquals(view.redactions[0].event, eventId);
    assertEquals(view.redactions[0].data.target, target);
  });
});

Deno.test('redact (G13): acceptance without effect — a foreign redactor with no power', async () => {
  await withRoom({ joinRule: 'public' }, async (g) => {
    await bobJoins(g, '@mallory:other.test');
    const target = await send(g, g.creator, 'alice says', 1001);
    // mallory redacts alice's event via direct ingest: the EVENT passes
    // the ordinary auth rules (he is joined; the event level is 0), but
    // the effect is denied — other.test ≠ test, and 0 < redact 50
    const redaction = await sendLocal(g.room, {
      type: 'm.room.redaction',
      sender: '@mallory:other.test',
      content: { redacts: target },
      origin_server_ts: 1002,
    }, g.signer);
    assertEquals(redaction.standing, 'accepted');
    const view = await redactionChanges(g);
    assertEquals(view.redactions.length, 0);
  });
});

Deno.test('redact (G13): the domain condition applies the effect for a same-server redactor', async () => {
  await withRoom({ joinRule: 'public' }, async (g) => {
    await bobJoins(g);
    const target = await send(g, g.creator, 'alice says', 1001);
    // the op gate would refuse bob (not the author, 0 < redact 50)…
    const denied = await assertRejects(() =>
      redactEvent(g.room, '@bob:test', target, g.signer)
    );
    assert(denied instanceof MatrixError);
    assertEquals(denied.status, 403);
    // …but the redaction EFFECT rule is the spec's domain condition
    // (v3-handling-redactions.md): bob's domain matches alice's, so the
    // effect applies when the event is ingested directly
    const redaction = await sendLocal(g.room, {
      type: 'm.room.redaction',
      sender: '@bob:test',
      content: { redacts: target },
      origin_server_ts: 1002,
    }, g.signer);
    assertEquals(redaction.standing, 'accepted');
    const view = await redactionChanges(g);
    assertEquals(view.redactions.length, 1);
    assertEquals(view.redactions[0].event, redaction.eventId);
    assertEquals(view.redactions[0].data.target, target);
  });
});
